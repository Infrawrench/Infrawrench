import { describe, expect, it, vi } from "vitest";

// `terraform.ts` and `runs.ts` import the database client at load; what is
// tested here builds values and touches no row.
vi.mock("../../db/client.js", () => ({ db: {} }));

const {
  FORK_REASON,
  PERSONAL_REASON,
  TERRAFORM_JOB_TOKEN_SECRET,
  initialApplyStatus,
  terraformCiRun,
  terraformCommitStatus,
  terraformDispatchRefusal,
  terraformRunUrls,
  terraformSkipReason,
  terraformStatusContext,
} = await import("../terraform");
const { dispatchBody } = await import("../runs");
type TerraformRunPlan = import("../terraform").TerraformRunPlan;

// Obviously fake, and in no real token format.
const CLONE_TOKEN = "clone-token-for-tests";
const SHA = "c".repeat(40);

const plan = (over: {
  run?: Partial<TerraformRunPlan["run"]>;
  workspace?: Partial<TerraformRunPlan["workspace"]>;
  connections?: string[];
}): TerraformRunPlan => ({
  run: {
    id: "run-1",
    kind: "plan",
    trigger: "pull-request",
    commitSha: SHA,
    branch: "feature/network",
    pullNumber: 12,
    startedByUserId: "user-1",
    ...over.run,
  },
  workspace: {
    name: "prod",
    rootPath: "infra/prod",
    branch: null,
    product: "terraform",
    toolVersion: null,
    variables: { region: "eu-central-1" },
    secretVariables: { db_password: "PROD_DB_PASSWORD" },
    ...over.workspace,
  },
  repository: { id: "repo-1", name: "infra", defaultBranch: "main" },
  namespace: { slug: "Acme" },
  organizationId: "org-1",
  connections: over.connections ?? ["AWS production"],
});

/** The row as `dispatchRun` reads it back: what an insert leaves null is null. */
const asRow = (values: ReturnType<typeof terraformCiRun>) => ({
  noTaskCache: false,
  pipelineFile: null,
  inputs: null,
  ...values,
  pipelineText: values.pipelineText ?? null,
  baseSha: values.baseSha ?? null,
  pullNumber: values.pullNumber ?? null,
  fromFork: values.fromFork ?? false,
  gitRepositoryId: values.gitRepositoryId ?? null,
});

describe("a Terraform run's CI run", () => {
  it("is a pull request run of the forge repository with a generated pipeline", () => {
    const values = terraformCiRun(plan({}));
    expect(values).toMatchObject({
      organizationId: "org-1",
      installationId: 0,
      gitRepositoryId: "repo-1",
      repoFullName: "Acme/infra",
      ownerKey: "git.infrawrench.com-acme",
      repoKey: "infra",
      event: "pull-request",
      branch: "pull/12",
      headRef: "feature/network",
      sha: SHA,
      pullNumber: 12,
      fromFork: false,
      status: "queued",
      terraformRunId: "run-1",
      dedupeKey: "terraform:run-1",
    });
    const text = values.pipelineText!;
    expect(text).toContain("platform: linux");
    expect(text).toContain("https://git.infrawrench.com/Acme/infra/terraform/prod/state");
    expect(text).toContain("https://git.infrawrench.com/Acme/infra/terraform/prod/runs/run-1/plan");
    expect(text).toContain("AWS production");
    expect(text).toContain("TF_VAR_region: eu-central-1");
    // A plan never applies.
    expect(text).not.toContain(" apply ");
  });

  it("names secrets in the pipeline and never holds one", () => {
    const values = terraformCiRun(plan({}));
    const text = values.pipelineText!;
    // The job token and the secret variable are references the runner fills.
    expect(text).toContain(`TF_HTTP_PASSWORD: "\${{ secrets.${TERRAFORM_JOB_TOKEN_SECRET} }}"`);
    expect(text).toContain('TF_VAR_db_password: "${{ secrets.PROD_DB_PASSWORD }}"');
    expect(text).not.toMatch(/iwj_/);

    // The request built from the row carries the clone token outside the
    // pipeline, and no `secrets` at all: the job token is minted and added
    // when the run is sent (`terraformDispatch`), never stored on the row.
    const body = dispatchBody(asRow(values), CLONE_TOKEN);
    expect(body["pipeline"]).toBe(text);
    expect(body["token"]).toBe(CLONE_TOKEN);
    expect(body).not.toHaveProperty("secrets");
    expect(String(body["pipeline"])).not.toContain(CLONE_TOKEN);
    expect(JSON.stringify(values)).not.toContain(CLONE_TOKEN);
    // From the repository itself, so the proxy adds the repository's secrets.
    expect(body).toMatchObject({
      event: "pull-request",
      ref: "refs/pull/12/head",
      trusted: true,
      repo: "https://git.infrawrench.com/Acme/infra.git",
    });
    // Only a manual run names a file or inputs.
    expect(body).not.toHaveProperty("pipeline-file");
  });

  it("applies on a push to the workspace's branch, with the plan it posts", () => {
    const values = terraformCiRun(
      plan({
        run: { kind: "apply", trigger: "push", branch: "release", pullNumber: null },
        workspace: { branch: "release" },
      }),
    );
    expect(values).toMatchObject({ event: "push", branch: "release", pullNumber: null });
    const text = values.pipelineText!;
    expect(text).toContain("branches:");
    expect(text).toContain("- release");
    expect(text).toContain(
      'apply -input=false -no-color -lock-timeout="$IW_TF_LOCK_TIMEOUT" "$out/tfplan"',
    );
    const body = dispatchBody(asRow(values), CLONE_TOKEN);
    expect(body).toMatchObject({ event: "push", branch: "release" });
    expect(body).not.toHaveProperty("trusted");
  });

  it("runs by hand as a manual run of the same generated text", () => {
    const values = terraformCiRun(
      plan({ run: { trigger: "manual", pullNumber: null, branch: "main" } }),
    );
    expect(values.event).toBe("manual");
    const body = dispatchBody(asRow(values), CLONE_TOKEN);
    expect(body).toMatchObject({ event: "manual", pipeline: values.pipelineText });
    expect(body).not.toHaveProperty("pipeline-file");
  });

  it("refuses a version it has no pinned release for, by name", () => {
    expect(() => terraformCiRun(plan({ workspace: { toolVersion: "~> 1.9" } }))).toThrow(
      /no pinned release.*1\.15\.8/,
    );
    expect(() => terraformCiRun(plan({ workspace: { toolVersion: "1.15.8" } }))).not.toThrow();
    const tofu = terraformCiRun(plan({ workspace: { product: "opentofu" } })).pipelineText!;
    expect(tofu).toContain("IW_TF_PRODUCT: opentofu");
  });

  it("gives a run its workspace's addresses and nothing else", () => {
    expect(terraformRunUrls("acme", "infra", "prod", "run 1")).toEqual({
      stateUrl: "https://git.infrawrench.com/acme/infra/terraform/prod/state",
      planUrl: "https://git.infrawrench.com/acme/infra/terraform/prod/runs/run%201/plan",
    });
  });
});

describe("who gets a run", () => {
  it("never plans a fork's pull request, and says why", () => {
    expect(terraformSkipReason({ fromFork: true, organizationId: "org-1" })).toBe(FORK_REASON);
    // A fork is refused before anything else is asked.
    expect(terraformSkipReason({ fromFork: true, organizationId: null })).toBe(FORK_REASON);
    expect(terraformSkipReason({ fromFork: false, organizationId: null })).toBe(PERSONAL_REASON);
    expect(terraformSkipReason({ fromFork: false, organizationId: "org-1" })).toBeNull();
  });

  it("makes an apply wait unless the workspace applies on merge without approval", () => {
    expect(initialApplyStatus({ applyOnMerge: true, autoApply: true })).toBe("queued");
    expect(initialApplyStatus({ applyOnMerge: true, autoApply: false })).toBe("awaiting_approval");
    expect(initialApplyStatus({ applyOnMerge: false, autoApply: true })).toBe("awaiting_approval");
    expect(initialApplyStatus({ applyOnMerge: false, autoApply: false })).toBe("awaiting_approval");
  });

  it("never sends a run that waits, was skipped or was replaced", () => {
    expect(terraformDispatchRefusal("awaiting_approval")).toMatch(/approval/);
    expect(terraformDispatchRefusal("skipped")).toMatch(/skipped/);
    expect(terraformDispatchRefusal("superseded")).not.toBeNull();
    expect(terraformDispatchRefusal("cancelled")).not.toBeNull();
    for (const status of ["queued", "running", "planned", "failed", "applied"] as const) {
      expect(terraformDispatchRefusal(status)).toBeNull();
    }
  });
});

describe("a run's commit status", () => {
  const run = {
    kind: "plan" as const,
    error: null,
    planSummary: null,
    resourcesToAdd: null,
    resourcesToChange: null,
    resourcesToDestroy: null,
  };
  const summary = { add: 2, change: 1, destroy: 0, hasChanges: true } as never;

  it("is the workspace's own context", () => {
    expect(terraformStatusContext("prod")).toBe("Infrawrench Terraform / prod");
  });

  it("says what the plan found", () => {
    expect(terraformCommitStatus({ ...run, status: "queued" })).toEqual({
      state: "pending",
      description: "Queued",
    });
    expect(terraformCommitStatus({ ...run, status: "running" })?.description).toBe("Planning");
    expect(
      terraformCommitStatus({
        ...run,
        status: "planned",
        planSummary: summary,
        resourcesToAdd: 2,
        resourcesToChange: 1,
        resourcesToDestroy: 0,
      }),
    ).toEqual({ state: "success", description: "Plan: 2 to add, 1 to change, 0 to destroy." });
    expect(
      terraformCommitStatus({
        ...run,
        status: "planned",
        planSummary: { ...(summary as object), hasChanges: false } as never,
      })?.description,
    ).toBe("No changes.");
  });

  it("holds an apply that waits as pending, and reports its end", () => {
    const apply = { ...run, kind: "apply" as const };
    expect(terraformCommitStatus({ ...apply, status: "awaiting_approval" })).toMatchObject({
      state: "pending",
    });
    expect(
      terraformCommitStatus({
        ...apply,
        status: "applied",
        planSummary: summary,
        resourcesToAdd: 2,
        resourcesToChange: 1,
        resourcesToDestroy: 0,
      }),
    ).toEqual({ state: "success", description: "Applied: 2 added, 1 changed, 0 destroyed." });
    expect(
      terraformCommitStatus({ ...apply, status: "failed", error: "The job failed: exit 1" }),
    ).toEqual({ state: "failure", description: "The job failed: exit 1" });
    expect(terraformCommitStatus({ ...apply, status: "cancelled" })?.state).toBe("error");
  });

  it("says nothing for a run that was skipped or replaced", () => {
    // A skipped run made no plan: a status would claim one passed or failed.
    expect(terraformCommitStatus({ ...run, status: "skipped", error: FORK_REASON })).toBeNull();
    expect(terraformCommitStatus({ ...run, status: "superseded" })).toBeNull();
  });
});
