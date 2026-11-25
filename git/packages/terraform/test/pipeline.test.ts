import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  BACKEND_OVERRIDE_FILE,
  Literal,
  PipelineInputError,
  backendConfiguration,
  backendEnvironment,
  renderYaml,
  workspacePipeline,
  workspacePipelineYaml,
  type WorkspacePipelineInput,
} from "../src/index.js";

const STATE_URL = "https://git.infrawrench.com/acme/infra/terraform/prod/state";

const input: WorkspacePipelineInput = {
  kind: "plan",
  workspace: { name: "prod", rootPath: "envs/prod" },
  stateUrl: STATE_URL,
  planUrl: "https://git.infrawrench.com/acme/infra/terraform/prod/runs/run_123/plan",
  release: {
    product: "terraform",
    version: "1.9.8",
    sha256: { amd64: "a".repeat(64), arm64: "b".repeat(64) },
  },
  defaultBranch: "main",
  connections: ["Production AWS", "Cloudflare"],
  variables: { region: "eu-west-1", replicas: "3" },
  secretVariables: { db_password: "PROD_DB_PASSWORD" },
};

type Job = {
  platform: string;
  cwd: string;
  connections: string[];
  env: Record<string, string>;
  run: Literal;
};

function jobOf(pipeline: ReturnType<typeof workspacePipeline>, key: string): Job {
  return (pipeline["jobs"] as unknown as Record<string, Job>)[key]!;
}

describe("the workspace pipeline", () => {
  it("plans on a pull request, in a Linux machine, in the root's directory", () => {
    const pipeline = workspacePipeline(input);
    expect(pipeline["name"]).toBe("Terraform plan: prod");
    expect(pipeline["on"]).toEqual({ "pull-request": {}, manual: {} });
    expect(pipeline["concurrency"]).toEqual({
      group: "terraform-prod-plan-${{ pull-request.number }}-${{ commit.branch }}",
      "cancel-in-progress": true,
    });
    const job = jobOf(pipeline, "plan");
    expect(job).toMatchObject({
      platform: "linux",
      cwd: "/app/envs/prod",
      connections: ["Production AWS", "Cloudflare"],
    });
    // A machine job has no `using:` or `tools:`; the runner refuses them there.
    expect(Object.keys(job)).not.toContain("using");
    expect(job.run.text).toContain('"$tf" plan -input=false');
    expect(job.run.text).not.toContain('"$tf" apply');
  });

  it("applies on the default branch, one at a time, the plan it just posted", () => {
    const pipeline = workspacePipeline({
      ...input,
      kind: "apply",
      workspace: { name: "prod", rootPath: "" },
    });
    expect(pipeline["on"]).toEqual({ push: { branches: ["main"] }, manual: {} });
    expect(pipeline["concurrency"]).toEqual({
      group: "terraform-prod-apply",
      "cancel-in-progress": false,
    });
    const job = jobOf(pipeline, "apply");
    expect(job.cwd).toBe("/app");
    const script = job.run.text;
    expect(script.indexOf('"$tf" plan')).toBeLessThan(script.indexOf("$IW_TF_PLAN_URL"));
    expect(script.indexOf("$IW_TF_PLAN_URL")).toBeLessThan(script.indexOf('"$tf" apply'));
    expect(script).toContain(
      'apply -input=false -no-color -lock-timeout="$IW_TF_LOCK_TIMEOUT" "$out/tfplan"',
    );
  });

  it("points Terraform at the forge's state with the job token as the password", () => {
    const { env } = jobOf(workspacePipeline(input), "plan");
    expect(env).toMatchObject({
      TF_HTTP_ADDRESS: STATE_URL,
      TF_HTTP_LOCK_ADDRESS: `${STATE_URL}/lock`,
      TF_HTTP_UNLOCK_ADDRESS: `${STATE_URL}/lock`,
      TF_HTTP_LOCK_METHOD: "POST",
      TF_HTTP_UNLOCK_METHOD: "DELETE",
      TF_HTTP_USERNAME: "infrawrench-ci",
      TF_HTTP_PASSWORD: "${{ secrets.IW_GIT_JOB_TOKEN }}",
      TF_IN_AUTOMATION: "1",
      TF_VAR_region: "eu-west-1",
      TF_VAR_replicas: "3",
      TF_VAR_db_password: "${{ secrets.PROD_DB_PASSWORD }}",
      IW_TF_VERSION: "1.9.8",
      IW_TF_SHA256_AMD64: "a".repeat(64),
    });
    expect(workspacePipeline({ ...input, tokenSecret: "FORGE_TOKEN" })["jobs"]).toMatchObject({
      plan: { env: { TF_HTTP_PASSWORD: "${{ secrets.FORGE_TOKEN }}" } },
    });
  });

  it("writes nothing of the workspace into the script", () => {
    const one = jobOf(workspacePipeline(input), "plan").run.text;
    const other = jobOf(
      workspacePipeline({
        ...input,
        workspace: { name: "staging", rootPath: "other/dir" },
        stateUrl: "https://git.example/x/y/terraform/staging/state",
        planUrl: "https://git.example/x/y/terraform/staging/runs/9/plan",
        release: { product: "opentofu", version: "1.8.5", sha256: { amd64: "c".repeat(64) } },
        connections: [],
        variables: {},
        secretVariables: {},
      }),
      "plan",
    ).run.text;
    expect(other).toBe(one);
    // And no secret is named in it: the runner only fills secrets into `env:`.
    expect(one).not.toContain("${{");
    expect(one).toContain(BACKEND_OVERRIDE_FILE);
  });

  it("is a script bash can parse", () => {
    for (const kind of ["plan", "apply"] as const) {
      const script = jobOf(workspacePipeline({ ...input, kind }), kind).run.text;
      execFileSync("bash", ["-n"], { input: `set -euo pipefail\n${script}\n` });
    }
  });

  it("renders as a pipeline file", () => {
    const yaml = workspacePipelineYaml({
      ...input,
      connections: ["Production AWS"],
      variables: {},
      secretVariables: {},
    });
    const [head, script] = yaml.split("    run: |\n");
    expect(head).toBe(`name: "Terraform plan: prod"
on:
  pull-request: {}
  manual: {}
concurrency:
  group: "terraform-prod-plan-\${{ pull-request.number }}-\${{ commit.branch }}"
  cancel-in-progress: true
jobs:
  plan:
    name: "Plan prod"
    platform: linux
    cwd: "/app/envs/prod"
    timeout: "60m"
    memory: "4GiB"
    connections:
      - "Production AWS"
    env:
      TF_HTTP_ADDRESS: "${STATE_URL}"
      TF_HTTP_LOCK_ADDRESS: "${STATE_URL}/lock"
      TF_HTTP_UNLOCK_ADDRESS: "${STATE_URL}/lock"
      TF_HTTP_LOCK_METHOD: POST
      TF_HTTP_UNLOCK_METHOD: DELETE
      TF_HTTP_USERNAME: infrawrench-ci
      TF_HTTP_PASSWORD: "\${{ secrets.IW_GIT_JOB_TOKEN }}"
      TF_IN_AUTOMATION: "1"
      TF_INPUT: "0"
      CHECKPOINT_DISABLE: "1"
      IW_TF_PRODUCT: terraform
      IW_TF_VERSION: "1.9.8"
      IW_TF_SHA256_AMD64: ${"a".repeat(64)}
      IW_TF_SHA256_ARM64: ${"b".repeat(64)}
      IW_TF_CACHE: "/root/.cache/infrawrench-terraform"
      IW_TF_PLAN_URL: "https://git.infrawrench.com/acme/infra/terraform/prod/runs/run_123/plan"
      IW_TF_LOCK_TIMEOUT: "10m"
    cache:
      key: infrawrench-terraform-terraform-1.9.8
      paths:
        - "/root/.cache/infrawrench-terraform"
`);
    // The script is a literal block, every line indented under `run:`.
    expect(script!.split("\n").every((line) => line === "" || line.startsWith("      "))).toBe(
      true,
    );
    expect(script).toContain('      case "$(uname -m)" in\n');
    expect(yaml.endsWith('rm -rf "$out"\n')).toBe(true);
  });

  it("refuses anything that could turn into something else in a pipeline", () => {
    const bad = (change: Partial<WorkspacePipelineInput>, message: RegExp) => {
      expect(() => workspacePipeline({ ...input, ...change })).toThrow(PipelineInputError);
      expect(() => workspacePipeline({ ...input, ...change })).toThrow(message);
    };
    bad({ workspace: { name: "Prod Env", rootPath: "" } }, /workspace name/);
    bad({ workspace: { name: "prod", rootPath: "../outside" } }, /root path/);
    bad({ workspace: { name: "prod", rootPath: "a/$(id)" } }, /root path/);
    bad({ stateUrl: "https://user:pw@git.example/state" }, /state URL/);
    bad({ stateUrl: 'https://git.example/state"; rm -rf /' }, /state URL/);
    bad({ planUrl: "ftp://git.example/plan" }, /plan URL/);
    bad({ release: { ...input.release, version: "latest" } }, /exact version/);
    bad({ release: { ...input.release, sha256: {} } }, /no SHA-256/);
    bad({ release: { ...input.release, sha256: { amd64: "xyz" } } }, /64 lowercase hex/);
    bad({ defaultBranch: "main; echo" }, /default branch/);
    bad({ connections: ["${{ secrets.X }}"] }, /connection name/);
    bad({ variables: { "bad-name": "x" } }, /variable name/);
    bad({ variables: { token: "${{ secrets.OTHER }}" } }, /holds an expression/);
    bad({ secretVariables: { password: "not a name" } }, /secret name/);
    bad({ lockTimeout: "soon" }, /lock timeout/);
    bad({ memory: "lots" }, /memory/);
  });
});

describe("backend configuration", () => {
  it("is the environment a job gets and the block a person writes", () => {
    expect(Object.keys(backendEnvironment(STATE_URL))).toEqual([
      "TF_HTTP_ADDRESS",
      "TF_HTTP_LOCK_ADDRESS",
      "TF_HTTP_UNLOCK_ADDRESS",
      "TF_HTTP_LOCK_METHOD",
      "TF_HTTP_UNLOCK_METHOD",
    ]);
    const block = backendConfiguration(STATE_URL, "astrid");
    expect(block).toContain(`address        = "${STATE_URL}"`);
    expect(block).toContain('username       = "astrid"');
    expect(block).not.toMatch(/^\s*password\s*=/m);
  });
});

describe("renderYaml", () => {
  it("quotes whatever a YAML reader could take for something else", () => {
    expect(
      renderYaml({
        on: { push: { branches: ["main", "release/*", "no", "1.0"] } },
        empty: [],
        flag: true,
        count: 3,
        text: "a: b #c",
        multi: "line one\nline two",
        items: [{ name: "x", value: "y z" }, { name: "w" }],
        script: new Literal("echo one\n\necho two\n"),
      }),
    ).toBe(`on:
  push:
    branches:
      - main
      - "release/*"
      - "no"
      - "1.0"
empty: []
flag: true
count: 3
text: "a: b #c"
multi: "line one\\nline two"
items:
  - name: x
    value: "y z"
  - name: w
script: |
  echo one

  echo two
`);
  });
});
