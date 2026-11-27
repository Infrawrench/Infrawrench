/**
 * Terraform's state backend end to end in workerd: the real `terraform`
 * against `wrangler dev`, with the real `TerraformStateDO` (its SQLite, its
 * serialisation), local R2 and the Worker's own routes. Only Postgres is a
 * fixture (`./entry.ts`); a run's credential is a real job token.
 *
 * Opt-in, because it starts workerd: `GIT_WORKER_E2E=1 pnpm --filter
 * @infrawrench/git-worker test`. Everything is `terraform_data`, so `init`
 * installs no provider and nothing leaves the loopback.
 */
import { execFile, execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signGitJobToken } from "@infrawrench/client-core";
import { SERVICE_TOKEN_PURPOSE, backendEnvironment } from "@infrawrench/git-terraform";
import type { StateHeadReport } from "../../src/terraform/state-serve";
import { tempDir } from "../support/git";
import type { Fixture } from "./entry";
import { JOB_TOKEN_KEY, type TestWorker, startWorker } from "./harness";

const TERRAFORM = (() => {
  for (const candidate of [
    process.env["TERRAFORM_BIN"],
    "terraform",
    "/opt/homebrew/bin/terraform",
  ]) {
    if (!candidate) continue;
    try {
      execFileSync(candidate, ["version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  return null;
})();

const enabled = process.env["GIT_WORKER_E2E"] === "1" && TERRAFORM !== null;

// Obviously fake, and in no real token format beyond the prefix the Worker routes by.
const ADMIN = "iwg_admin-token-for-tests";
const WRITER = "iwg_writer-token-for-tests";
const READER = "iwg_reader-token-for-tests";

const CONFIG = `
terraform {
  backend "http" {}
}
variable "release" {
  type    = string
  default = "v1"
}
resource "terraform_data" "app" {
  input = var.release
}
resource "terraform_data" "fleet" {
  count = 2
  input = "node-\${count.index}"
}
`;

interface Recorded {
  heads: Array<{ workspaceId: string; report: StateHeadReport; principal: { kind: string } }>;
  plans: Array<{ runId: string; ciRunId: string; summary: { add: number } }>;
  objects: string[];
}

describe.skipIf(!enabled)("terraform against the worker in workerd", () => {
  let worker: TestWorker;
  let dir: string;
  let stateUrl: string;
  let jobToken: string;
  let serviceToken: string;
  let env: NodeJS.ProcessEnv;

  /** A job token as server-core mints one for a run: bound to the run's workspace. */
  const token = (
    runId: string,
    access: "read" | "write",
    options: { repositoryId?: string; workspace?: string | null } = {},
  ) =>
    signGitJobToken(JOB_TOKEN_KEY, {
      repositoryId: options.repositoryId ?? "repo-tf",
      access,
      runId,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      ...(options.workspace === null ? {} : { workspace: options.workspace ?? "ws-e2e" }),
    });

  beforeAll(async () => {
    const fixture: Fixture = {
      tokens: {
        // Owl owns the namespace, so administers the repository; Wren only writes it.
        [ADMIN]: { userId: "owl", scopes: ["repo:write"] },
        [WRITER]: { userId: "wren", scopes: ["repo:write"] },
        [READER]: { userId: "robin", scopes: ["repo:read", "repo:write"] },
      },
      keys: {},
      users: { owl: "owl", wren: "wren", robin: "robin" },
      repositories: [
        {
          id: "repo-tf",
          owner: "acme",
          name: "infra",
          ownerUserId: "owl",
          // Public: anyone reads the repository, and only its administrators its state.
          visibility: "public",
          collaborators: { wren: "write" },
        },
      ],
      workspaces: [
        { id: "ws-e2e", repositoryId: "repo-tf", name: "prod", liveCiRun: "ci-7", liveRun: "tf-7" },
      ],
    };
    worker = await startWorker(fixture);
    stateUrl = `${worker.httpUrl}/acme/infra/terraform/prod/state`;
    jobToken = await token("ci-7", "write");
    serviceToken = await token(SERVICE_TOKEN_PURPOSE, "read");
    dir = tempDir("terraform-e2e");
    await writeFile(join(dir, "main.tf"), CONFIG);
    env = {
      PATH: process.env["PATH"],
      HOME: dir,
      TF_IN_AUTOMATION: "1",
      TF_INPUT: "0",
      CHECKPOINT_DISABLE: "1",
      TF_HTTP_RETRY_MAX: "0",
      TF_HTTP_USERNAME: "infrawrench-ci",
      TF_HTTP_PASSWORD: jobToken,
      ...backendEnvironment(stateUrl),
    };
  });
  afterAll(async () => {
    await worker?.stop();
  });

  const terraform = (args: readonly string[], extra: NodeJS.ProcessEnv = {}) =>
    new Promise<{ code: number; output: string; stdout: string }>((resolve) => {
      execFile(
        TERRAFORM!,
        [...args],
        { cwd: dir, env: { ...env, ...extra }, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
          resolve({ code, output: `${stdout}\n${stderr}`, stdout });
        },
      );
    });
  const ok = async (args: readonly string[], extra?: NodeJS.ProcessEnv) => {
    const run = await terraform(args, extra);
    if (run.code !== 0) {
      throw new Error(`terraform ${args.join(" ")} failed:\n${run.output}\n${worker.output()}`);
    }
    return run.stdout;
  };
  const basic = (password: string) => ({
    authorization: `Basic ${Buffer.from(`x:${password}`).toString("base64")}`,
  });
  const recorded = async (): Promise<Recorded> =>
    (await fetch(`${worker.httpUrl}/__test/terraform`)).json() as Promise<Recorded>;
  const rpc = async <T>(method: string, ...args: string[]): Promise<T> => {
    const response = await fetch(`${worker.httpUrl}/__test/terraform-rpc`, {
      method: "POST",
      body: JSON.stringify({ workspaceId: "ws-e2e", method, args }),
    });
    const answer = (await response.json()) as { ok: boolean; result: T; error?: string };
    if (!answer.ok) throw new Error(answer.error);
    return answer.result;
  };

  it("applies with a run's job token: state in R2, the head in the object", async () => {
    await ok(["init", "-no-color"]);
    await ok(["apply", "-auto-approve", "-no-color"]);
    expect((await ok(["state", "list"])).trim().split("\n").sort()).toEqual([
      "terraform_data.app",
      "terraform_data.fleet[0]",
      "terraform_data.fleet[1]",
    ]);
    const { heads, objects } = await recorded();
    const states = objects.filter((key) => key.endsWith(".tfstate"));
    expect(states.length).toBeGreaterThanOrEqual(1);
    for (const key of states) expect(key).toMatch(/^terraform\/ws-e2e\/\d+-[0-9a-z]{22}\.tfstate$/);
    const head = await rpc<StateHeadReport>("head");
    expect(head.lock).toBeNull();
    expect(head.version).toMatchObject({ resourceCount: 2, createdBy: "ci:ci-7" });
    expect(heads.at(-1)!.report.version?.id).toBe(head.version!.id);
    expect(heads.at(-1)!.principal.kind).toBe("job");
    expect(
      heads
        .flatMap((entry) => entry.report.written ?? [])
        .map((v) => v.r2Key)
        .sort(),
    ).toEqual(states.sort());
  });

  it("serialises writers on the lock, and only an admin forces it open", async () => {
    const info = {
      ID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      Operation: "OperationTypeApply",
      Info: "",
      Who: "wren@a-laptop",
      Version: "1.9.0",
      Created: new Date().toISOString(),
      Path: "",
    };
    // Writing the repository is not using its state: that takes an administrator.
    const member = await fetch(`${stateUrl}/lock`, {
      method: "POST",
      headers: basic(WRITER),
      body: JSON.stringify(info),
    });
    expect(member.status).toBe(403);
    const lock = await fetch(`${stateUrl}/lock`, {
      method: "POST",
      headers: basic(ADMIN),
      body: JSON.stringify(info),
    });
    expect(lock.status).toBe(200);
    // Terraform's own LOCK method reaches the object too, and finds it held.
    const again = await fetch(stateUrl, {
      method: "LOCK",
      headers: basic(jobToken),
      body: JSON.stringify({ ...info, ID: "another" }),
    });
    expect(again.status).toBe(423);
    expect(((await again.json()) as { Who: string }).Who).toBe("wren@a-laptop");

    const blocked = await terraform(["apply", "-auto-approve", "-no-color", "-lock-timeout=0s"], {
      TF_VAR_release: "v2",
    });
    expect(blocked.code).not.toBe(0);
    expect(blocked.output).toContain("wren@a-laptop");

    // A personal token never administers, so it cannot force the lock open.
    expect(
      (await fetch(`${stateUrl}/lock`, { method: "DELETE", headers: basic(ADMIN) })).status,
    ).toBe(403);
    expect((await rpc<StateHeadReport>("forceUnlock")).lock).toBeNull();
    await ok(["apply", "-auto-approve", "-no-color"], { TF_VAR_release: "v2" });
  });

  it("refuses readers with 403, strangers with 401, and never with a 404", async () => {
    expect((await fetch(stateUrl)).status).toBe(401);
    // Robin's token has `repo:write`, but Robin only reads this public repository.
    expect((await fetch(stateUrl, { headers: basic(READER) })).status).toBe(403);
    expect((await fetch(stateUrl, { headers: basic(WRITER) })).status).toBe(403);
    // Another run's token, another repository's, another workspace's.
    for (const other of [
      await token("ci-8", "write"),
      await token("ci-7", "write", { repositoryId: "repo-other" }),
      await token("ci-7", "write", { workspace: "ws-other" }),
    ]) {
      expect((await fetch(stateUrl, { headers: basic(other) })).status).toBe(403);
    }
    // A job token that names no workspace is not a credential here at all,
    // whatever it may do to the repository: the live run's own id on a
    // `write` token, which is what a run used to get, and the app's.
    for (const unbound of [
      await token("ci-7", "write", { workspace: null }),
      await token(SERVICE_TOKEN_PURPOSE, "read", { workspace: null }),
    ]) {
      const refused = await fetch(stateUrl, { headers: basic(unbound) });
      expect(refused.status).toBe(401);
      expect(refused.headers.get("www-authenticate")).toContain("Basic");
    }
    expect(
      (await fetch(`${worker.httpUrl}/acme/infra/terraform/nope/state`, { headers: basic(ADMIN) }))
        .status,
    ).toBe(403);
    const refused = await terraform(["plan", "-no-color"], { TF_HTTP_PASSWORD: READER });
    expect(refused.code).not.toBe(0);
    expect(refused.output).not.toContain("to add");
    // The app's own token reads.
    const read = await fetch(stateUrl, { headers: { authorization: `Bearer ${serviceToken}` } });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { resources: unknown[] }).resources).toHaveLength(2);
  });

  it("gives a plan's token the lock and the state, and nothing to write", async () => {
    const planToken = await token("ci-7", "read");
    const current = await fetch(stateUrl, { headers: basic(planToken) });
    expect(current.status).toBe(200);
    const body = await current.text();
    await ok(["plan", "-no-color", "-lock-timeout=5s"], { TF_HTTP_PASSWORD: planToken });
    const write = await fetch(stateUrl, { method: "POST", headers: basic(planToken), body });
    expect(write.status).toBe(403);
    const applied = await terraform(["apply", "-auto-approve", "-no-color"], {
      TF_HTTP_PASSWORD: planToken,
      TF_VAR_release: "v8",
    });
    expect(applied.code).not.toBe(0);
    expect((await rpc<StateHeadReport>("head")).lock).toBeNull();
  });

  it("keeps a run's token to its state: it does not clone, push, or read a file", async () => {
    const git = (path: string, init: RequestInit = {}) =>
      fetch(`${worker.httpUrl}${path}`, { ...init, headers: basic(jobToken) });
    // The repository is public, so no credential at all would read it: a
    // credential that is refused is a 401 all the same, never the anonymous answer.
    for (const path of [
      "/acme/infra.git/info/refs?service=git-receive-pack",
      "/acme/infra.git/info/refs?service=git-upload-pack",
      `/acme/infra/raw/${"a".repeat(40)}/main.tf`,
      `/acme/infra/archive/${"a".repeat(40)}.tar.gz`,
    ]) {
      expect((await git(path)).status, path).toBe(401);
    }
    expect((await git("/acme/infra.git/git-receive-pack", { method: "POST" })).status).toBe(401);
    expect((await git("/acme/infra.git/git-upload-pack", { method: "POST" })).status).toBe(401);
  });

  it("lists versions newest first and restores an old one as a new version", async () => {
    const before = await rpc<StateHeadReport>("head");
    const { heads } = await recorded();
    const written = heads.flatMap((entry) => entry.report.written ?? []);
    expect(written.length).toBeGreaterThanOrEqual(2);
    const oldest = written[0]!;
    const restored = await rpc<{ kind: string; head: StateHeadReport }>(
      "restore",
      oldest.id,
      "user:owl",
    );
    expect(restored.kind).toBe("restored");
    expect(restored.head.version).toMatchObject({
      serial: before.version!.serial + 1,
      lineage: oldest.lineage,
      createdBy: "user:owl",
    });
    const pulled = JSON.parse(await ok(["state", "pull"])) as { serial: number };
    expect(pulled.serial).toBe(before.version!.serial + 1);
    // Every version's object is still in the bucket, the new one beside them.
    const { objects } = await recorded();
    expect(objects.filter((key) => key.endsWith(".tfstate")).length).toBe(written.length + 1);
  });

  it("takes the run's plan once, from its own job", async () => {
    await ok(["plan", "-no-color", "-out=tfplan"], { TF_VAR_release: "v3" });
    const document = await ok(["show", "-json", "tfplan"]);
    const planUrl = `${worker.httpUrl}/acme/infra/terraform/prod/runs/tf-7/plan`;
    const post = (password: string, url = planUrl) =>
      fetch(url, {
        method: "POST",
        headers: { ...basic(password), "content-type": "application/json" },
        body: document,
      });
    expect((await post(WRITER)).status).toBe(403);
    expect((await post(ADMIN)).status).toBe(403);
    expect((await post(await token("ci-7", "write", { workspace: null }))).status).toBe(401);
    expect((await post(jobToken, planUrl.replace("tf-7", "tf-8"))).status).toBe(403);
    expect((await post(jobToken)).status).toBe(204);
    const { plans, objects } = await recorded();
    expect(plans.at(-1)).toMatchObject({ runId: "tf-7", ciRunId: "ci-7" });
    expect(objects).toContain("terraform/ws-e2e/plans/tf-7.json");
    const priced = await fetch(planUrl, { headers: { authorization: `Bearer ${serviceToken}` } });
    expect(priced.status).toBe(200);
    await priced.arrayBuffer();
    expect((await recorded()).objects).not.toContain("terraform/ws-e2e/plans/tf-7.json");
  });
});
