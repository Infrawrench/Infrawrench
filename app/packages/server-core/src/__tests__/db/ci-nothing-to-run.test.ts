/**
 * CI runs with nothing to run, against a real Postgres: a push or pull
 * request no pipeline runs on ends `skipped` without reaching the runners,
 * shows nothing on GitHub for a push, and stays out of the run list. The CI
 * proxy and GitHub are fakes that record what they were asked.
 *
 * Skipped unless DATABASE_URL is set, migrations applied, scratch databases
 * only: it writes an organization and its runs, and deletes them after.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const configured = !!process.env["DATABASE_URL"];

interface Call {
  path: string;
  body: Record<string, unknown> | null;
}

/** What the fakes answer and were asked. */
const fake = {
  proxy: [] as Call[],
  github: [] as Call[],
  /** Per commit: what `POST /v1/concurrency` answers. */
  concurrency: new Map<string, Record<string, unknown>>(),
  /** Per proxy run id: what `GET /v1/runs/{id}` answers. */
  runs: new Map<string, Record<string, unknown>>(),
  next: 0,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const parse = (init: RequestInit = {}) =>
  init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;

vi.mock("../../entitlements.js", () => ({ planAccess: async () => ({ paid: true }) }));
vi.mock("../../github/app.js", () => ({
  getInstallationToken: async () => "installation-token-for-tests",
  githubInstallationFetch: async (_installation: number, path: string, init?: RequestInit) => {
    fake.github.push({ path, body: parse(init) });
    return json(201, { id: 4242 });
  },
}));
vi.mock("../../ci/proxy.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../ci/proxy.js")>();
  const proxyFetch = async (path: string, init: RequestInit = {}) => {
    const body = parse(init);
    fake.proxy.push({ path, body });
    if (path === "/v1/concurrency") {
      return json(200, fake.concurrency.get(String(body?.["sha"])) ?? { pipelines: [] });
    }
    if (path === "/v1/runs") {
      const id = `ci-1.${(++fake.next).toString(16).padStart(32, "0")}`;
      fake.runs.set(id, { id, state: "running" });
      return json(202, { id, state: "running" });
    }
    const status = /^\/v1\/runs\/([^/?]+)/.exec(path);
    const run = status ? fake.runs.get(decodeURIComponent(status[1] ?? "")) : undefined;
    return run ? json(200, run) : json(404, { error: "no such run" });
  };
  return {
    ...real,
    ciProxyConfigured: () => true,
    proxyFetch,
    proxyJson: async (path: string, init?: RequestInit) => {
      const res = await proxyFetch(path, init);
      if (!res.ok) throw new real.CiProxyError("no", res.status);
      return res.json();
    },
  };
});

const orgId = `test-org-${randomUUID()}`;
const installationId = 910_000_000 + Math.floor(Math.random() * 1_000_000);
const repo = "Acme/Web";

const TEST_PIPELINE = { file: ".infrawrench/ci/test.yml", name: "Test", concurrency: null };

describe.skipIf(!configured)("CI runs with nothing to run, against a real Postgres", () => {
  let sha = 0;

  async function modules() {
    const { db } = await import("../../db/client");
    const schema = await import("../../db/schema");
    const runs = await import("../../ci/runs");
    return { db, schema, runs };
  }

  /** A delivery for a new commit, which `answer` says the commit's pipelines are for. */
  async function deliver(
    kind: "push" | "pull_request",
    answer: Record<string, unknown>,
  ): Promise<string> {
    const { runs, db, schema } = await modules();
    const { eq } = await import("drizzle-orm");
    const commit = (++sha).toString(16).padStart(40, "0");
    fake.concurrency.set(commit, answer);
    const accepted = await runs.acceptCiEvent(
      kind === "push"
        ? {
            kind: "push",
            baseSha: null,
            installationId,
            repoFullName: repo,
            branch: "feat/ci-github-token",
            sha: commit,
            defaultBranch: "main",
            actorLogin: "octocat",
          }
        : {
            kind: "pull_request",
            installationId,
            repoFullName: repo,
            number: 1230,
            headSha: commit,
            headRef: "feat/ci-github-token",
            headRepoFullName: repo,
            baseSha: "f".repeat(40),
            defaultBranch: "main",
            actorLogin: "octocat",
            fromFork: false,
          },
    );
    if (!accepted) throw new Error("not accepted");
    // Due now by this process's clock, not only by the database's.
    await db
      .update(schema.ciRuns)
      .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.ciRuns.id, accepted.id));
    await runs.dispatchRun(accepted.id);
    return accepted.id;
  }

  async function row(id: string) {
    const { db, schema } = await modules();
    const { eq } = await import("drizzle-orm");
    const [r] = await db.select().from(schema.ciRuns).where(eq(schema.ciRuns.id, id));
    if (!r) throw new Error(`no run ${id}`);
    return r;
  }

  /** The runner finishes a run with this result, and the poller reads it. */
  async function finishOnRunner(id: string, result: Record<string, unknown>) {
    const { runs } = await modules();
    const r = await row(id);
    fake.runs.set(r.proxyRunId ?? "", {
      id: r.proxyRunId,
      state: "finished",
      result: { usage: { vcpu_seconds: 0.4, memory_gib_seconds: 0.2 }, ...result },
    });
    await runs.syncRun(await row(id));
  }

  const sentRuns = () => fake.proxy.filter((c) => c.path === "/v1/runs");
  const checks = () => fake.github.filter((c) => c.path.includes("/check-runs"));

  beforeEach(() => {
    fake.proxy = [];
    fake.github = [];
  });

  afterAll(async () => {
    if (!configured) return;
    const { db, schema } = await modules();
    const { eq } = await import("drizzle-orm");
    await db.delete(schema.ciRuns).where(eq(schema.ciRuns.organizationId, orgId));
    await db.delete(schema.ciSchedules).where(eq(schema.ciSchedules.organizationId, orgId));
    await db.delete(schema.ciAccounts).where(eq(schema.ciAccounts.organizationId, orgId));
    await db
      .delete(schema.githubInstallations)
      .where(eq(schema.githubInstallations.organizationId, orgId));
    await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    await db.$client.end();
  });

  it("sets up an organization running CI for an installation", async () => {
    const { db, schema } = await modules();
    await db.insert(schema.organizations).values({ id: orgId, displayName: "CI test" });
    await db.insert(schema.githubInstallations).values({
      id: randomUUID(),
      organizationId: orgId,
      installationId,
      accountLogin: "acme",
    } as typeof schema.githubInstallations.$inferInsert);
    await db.insert(schema.ciAccounts).values({
      id: randomUUID(),
      organizationId: orgId,
      installationId,
      accountLogin: "acme",
    });
  });

  it("skips a push no pipeline runs on: no run sent, no check, out of the list", async () => {
    const { runs } = await modules();
    const id = await deliver("push", { commit: "x", pipelines: [], invalid: [] });
    const r = await row(id);
    expect(r.status).toBe("skipped");
    expect(r.statusReason).toBe("No pipeline runs on this push.");
    expect(r.proxyRunId).toBeNull();
    expect(r.vcpuSeconds).toBeNull();
    expect(fake.proxy.map((c) => c.path)).toEqual(["/v1/concurrency"]);
    expect(sentRuns()).toEqual([]);
    expect(checks()).toEqual([]);

    const listed = await runs.listRuns(orgId, { limit: 50 });
    expect(listed.map((x) => x.id)).not.toContain(id);
    const asked = await runs.listRuns(orgId, { limit: 50, status: "skipped" });
    expect(asked.map((x) => x.id)).toContain(id);
    expect((await runs.getRun(orgId, id)).run.status).toBe("skipped");
  });

  it("still runs a push a pipeline runs on", async () => {
    const { runs } = await modules();
    const id = await deliver("push", {
      commit: "x",
      pipelines: [TEST_PIPELINE],
      invalid: [],
    });
    expect((await row(id)).status).toBe("running");
    expect(sentRuns()).toHaveLength(1);
    expect(checks()).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ status: "in_progress" }) }),
    ]);
    await finishOnRunner(id, {
      passed: true,
      pipelines: [
        {
          outcome: "ran",
          file: TEST_PIPELINE.file,
          report: {
            pipeline: "Test",
            jobs: [{ id: "test", name: "Test", status: "passed", duration_ms: 1000 }],
          },
        },
      ],
    });
    expect((await row(id)).status).toBe("passed");
    expect((await runs.listRuns(orgId, { limit: 50 })).map((x) => x.id)).toContain(id);
  });

  it("runs a push whose only pipeline file is broken, so the run reports it", async () => {
    const id = await deliver("push", {
      commit: "x",
      pipelines: [],
      invalid: [{ file: ".infrawrench/ci/test.yml", errors: ["jobs: required"] }],
    });
    expect((await row(id)).status).toBe("running");
    expect(sentRuns()).toHaveLength(1);
  });

  it("gives a pull request no pipeline runs on one skipped check, which a required check accepts", async () => {
    const id = await deliver("pull_request", { commit: "x", pipelines: [], invalid: [] });
    expect((await row(id)).status).toBe("skipped");
    expect(sentRuns()).toEqual([]);
    expect(checks()).toEqual([
      expect.objectContaining({
        path: `/repos/Acme/Web/check-runs`,
        body: expect.objectContaining({
          name: "Infrawrench CI / pull request",
          status: "completed",
          conclusion: "skipped",
        }),
      }),
    ]);
  });

  it("sends a run when an older runner cannot say, and skips it once it ran nothing", async () => {
    // No `invalid`: an empty list may hide a broken file.
    const id = await deliver("push", { commit: "x", pipelines: [] });
    expect((await row(id)).status).toBe("running");
    expect(sentRuns()).toHaveLength(1);
    // No "Running" check for a run nothing is known to run in.
    expect(checks()).toEqual([]);
    await finishOnRunner(id, {
      passed: true,
      pipelines: [{ outcome: "not-triggered", file: TEST_PIPELINE.file, name: "Test" }],
    });
    const r = await row(id);
    expect(r.status).toBe("skipped");
    // It did use a runner, briefly: that stays recorded.
    expect(r.vcpuSeconds).toBeCloseTo(0.4);
    expect(checks()).toEqual([]);
  });

  it("leaves skipped runs out of the month's run count", async () => {
    const { ciUsage } = await import("../../ci/billing");
    const { runs } = await modules();
    const usage = await ciUsage(orgId);
    const finished = await runs.listRuns(orgId, { limit: 50 });
    expect(usage.runs).toBe(finished.filter((r) => r.finishedAt !== null).length);
  });
});
