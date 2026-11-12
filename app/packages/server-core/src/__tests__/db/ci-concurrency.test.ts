/**
 * CI `concurrency:` groups against a real Postgres: admission's advisory
 * lock, its row updates and the jsonb bookkeeping of cancelled pipelines.
 * The CI proxy and GitHub are fakes; the unit suite (`ci/__tests__/
 * concurrency.test.ts`) covers the decision itself.
 *
 * Skipped unless DATABASE_URL is set, migrations applied, scratch databases
 * only: it writes an organization and its runs, and deletes them after.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const configured = !!process.env["DATABASE_URL"];

interface ProxyCall {
  path: string;
  body: unknown;
}

/** What the fake proxy answers and was asked. */
const proxy = {
  calls: [] as ProxyCall[],
  /** Per commit: the pipelines `POST /v1/concurrency` answers. */
  pipelines: new Map<string, unknown[]>(),
  /** Per proxy run id: what `GET /v1/runs/{id}` answers. */
  runs: new Map<string, Record<string, unknown>>(),
  next: 0,
};

vi.mock("../../features.js", () => ({ orgHasFeature: async () => true }));
vi.mock("../../entitlements.js", () => ({ planAccess: async () => ({ paid: true }) }));
vi.mock("../../github/app.js", () => ({
  getInstallationToken: async () => "installation-token-for-tests",
  githubInstallationFetch: async () =>
    new Response(JSON.stringify({ id: 1 }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
}));
vi.mock("../../ci/proxy.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../ci/proxy.js")>();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const proxyFetch = async (path: string, init: RequestInit = {}) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    proxy.calls.push({ path, body });
    if (path === "/v1/concurrency") {
      return json(200, { pipelines: proxy.pipelines.get(String(body?.["sha"])) ?? [] });
    }
    if (path === "/v1/runs") {
      const id = `ci-1.${(++proxy.next).toString(16).padStart(32, "0")}`;
      proxy.runs.set(id, { id, state: "running" });
      return json(202, { id, state: "running" });
    }
    const cancel = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(path);
    if (cancel) return json(202, { id: decodeURIComponent(cancel[1] ?? ""), state: "cancelling" });
    const status = /^\/v1\/runs\/([^/?]+)/.exec(path);
    const run = status ? proxy.runs.get(decodeURIComponent(status[1] ?? "")) : undefined;
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
const installationId = 900_000_000 + Math.floor(Math.random() * 1_000_000);
const repo = "Acme/Web";

const pipelines = (group: string, cancel: boolean) => [
  {
    file: ".infrawrench/ci/test.yml",
    name: "Test",
    concurrency: { group, "cancel-in-progress": cancel },
  },
  { file: ".infrawrench/ci/deploy.yml", name: "Deploy", concurrency: null },
];

describe.skipIf(!configured)("CI concurrency groups against a real Postgres", () => {
  let sha = 0;

  async function modules() {
    const { db } = await import("../../db/client");
    const schema = await import("../../db/schema");
    const runs = await import("../../ci/runs");
    const concurrency = await import("../../ci/concurrency");
    const pass = await import("../../ci/pass");
    return { db, schema, runs, concurrency, pass };
  }

  /** A push of a new commit to `branch`, its pipelines in `group`. */
  async function push(branch: string, group: string, cancel: boolean): Promise<string> {
    const { runs } = await modules();
    const commit = (++sha).toString(16).padStart(40, "0");
    proxy.pipelines.set(commit, pipelines(group, cancel));
    const accepted = await runs.acceptCiEvent({
      kind: "push",
      installationId,
      repoFullName: repo,
      branch,
      sha: commit,
      defaultBranch: "main",
      actorLogin: "octocat",
    });
    if (!accepted) throw new Error("not accepted");
    await due(accepted.id);
    return accepted.id;
  }

  /** Due now by this process's clock, not only by the database's. */
  async function due(id: string) {
    const { db, schema } = await modules();
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.ciRuns)
      .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.ciRuns.id, id));
  }

  async function row(id: string) {
    const { db, schema } = await modules();
    const { eq } = await import("drizzle-orm");
    const [r] = await db.select().from(schema.ciRuns).where(eq(schema.ciRuns.id, id));
    if (!r) throw new Error(`no run ${id}`);
    return r;
  }

  /** The runner finishes a run with this result. */
  async function finishOnRunner(id: string, result: Record<string, unknown>) {
    const r = await row(id);
    proxy.runs.set(r.proxyRunId ?? "", {
      id: r.proxyRunId,
      state: "finished",
      result: { usage: {}, ...result },
    });
  }

  beforeEach(() => {
    proxy.calls = [];
  });

  afterAll(async () => {
    if (!configured) return;
    const { db, schema } = await modules();
    const { eq } = await import("drizzle-orm");
    await db.delete(schema.ciRuns).where(eq(schema.ciRuns.organizationId, orgId));
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

  it("cancels the older run's pipelines in a cancel-in-progress group, and only those", async () => {
    const { runs, pass } = await modules();
    const first = await push("main", "ci-main", true);
    await runs.dispatchRun(first);
    expect((await row(first)).status).toBe("running");

    const second = await push("main", "CI-Main", true);
    await runs.dispatchRun(second);
    expect((await row(second)).status).toBe("running");

    const older = await row(first);
    expect(older.status).toBe("running");
    expect(older.concurrency).toEqual([
      expect.objectContaining({
        file: ".infrawrench/ci/test.yml",
        cancelled: true,
        cancelSent: true,
      }),
      expect.objectContaining({ file: ".infrawrench/ci/deploy.yml", group: null }),
    ]);
    expect(older.concurrency?.[1]?.cancelled).toBeUndefined();
    expect(proxy.calls).toContainEqual({
      path: `/v1/runs/${encodeURIComponent(older.proxyRunId ?? "")}/cancel`,
      body: { pipelines: [".infrawrench/ci/test.yml"] },
    });

    // The runner stops it; the report says cancelled.
    await finishOnRunner(first, {
      passed: false,
      cancelled: true,
      pipelines: [
        {
          outcome: "ran",
          file: ".infrawrench/ci/test.yml",
          report: {
            pipeline: "Test",
            jobs: [{ id: "unit", name: "unit", status: "cancelled", reason: "cancelled" }],
          },
        },
      ],
    });
    proxy.calls = [];
    await pass.runCiStatusPass();
    const done = await row(first);
    expect(done.status).toBe("cancelled");
    expect(done.statusReason).toBe("Cancelled by a newer run of its concurrency group `ci-main`.");
    // Its cancel was sent once; the pass does not send it again.
    expect(proxy.calls.filter((c) => c.path.endsWith("/cancel"))).toEqual([]);
    await finishOnRunner(second, { passed: true, pipelines: [] });
    await pass.runCiStatusPass();
    expect((await row(second)).status).toBe("passed");
  });

  it("queues behind a run without cancel-in-progress and keeps only the newest waiting", async () => {
    const { runs, pass } = await modules();
    const holder = await push("release", "deploy", false);
    await runs.dispatchRun(holder);
    expect((await row(holder)).status).toBe("running");

    const second = await push("release", "deploy", false);
    await runs.dispatchRun(second);
    expect((await row(second)).status).toBe("pending");
    expect((await row(second)).statusReason).toMatch(/Waiting for its concurrency group `deploy`/);

    const third = await push("release", "deploy", false);
    await runs.dispatchRun(third);
    expect((await row(third)).status).toBe("pending");
    expect((await row(second)).status).toBe("cancelled");
    expect(proxy.calls.filter((c) => c.path.endsWith("/cancel"))).toEqual([]);

    // Still held: a pass leaves it waiting.
    await pass.runCiStatusPass();
    expect((await row(third)).status).toBe("pending");

    await finishOnRunner(holder, { passed: true, pipelines: [] });
    await pass.runCiStatusPass(); // the holder finishes
    await pass.runCiStatusPass(); // the waiting run goes
    expect((await row(holder)).status).toBe("passed");
    expect((await row(third)).status).toBe("running");
    await finishOnRunner(third, { passed: true, pipelines: [] });
    await pass.runCiStatusPass();
  });

  it("admits one of two runs dispatched at once into a group", async () => {
    const { runs, pass } = await modules();
    const ids = await Promise.all(
      Array.from({ length: 4 }, (_, i) => push(`race-${i}`, "race", false)),
    );
    await Promise.all(ids.map((id) => runs.dispatchRun(id)));
    const statuses = await Promise.all(ids.map(async (id) => (await row(id)).status));
    expect(statuses.filter((s) => s === "running")).toHaveLength(1);
    expect(statuses.filter((s) => s === "pending").length).toBeLessThanOrEqual(1);
    for (const id of ids) {
      if ((await row(id)).status === "running") {
        await finishOnRunner(id, { passed: true, pipelines: [] });
      }
    }
    await pass.runCiStatusPass();
    await pass.runCiStatusPass();
    for (const id of ids) {
      if ((await row(id)).status === "running") {
        await finishOnRunner(id, { passed: true, pipelines: [] });
      }
    }
    await pass.runCiStatusPass();
    const final = await Promise.all(ids.map(async (id) => (await row(id)).status));
    expect(final.every((s) => s === "passed" || s === "cancelled")).toBe(true);
  });

  it("runs different groups side by side", async () => {
    const { runs } = await modules();
    const a = await push("feature-a", "ci-feature-a", false);
    const b = await push("feature-b", "ci-feature-b", false);
    await runs.dispatchRun(a);
    await runs.dispatchRun(b);
    expect((await row(a)).status).toBe("running");
    expect((await row(b)).status).toBe("running");
    await finishOnRunner(a, { passed: true, pipelines: [] });
    await finishOnRunner(b, { passed: true, pipelines: [] });
    await (await modules()).pass.runCiStatusPass();
  });

  it("supersedes an older run that reads its groups after a newer one went", async () => {
    const { runs } = await modules();
    const older = await push("hotfix", "hotfix", true);
    const newer = await push("hotfix", "hotfix", true);
    await runs.dispatchRun(newer);
    await runs.dispatchRun(older);
    expect((await row(newer)).status).toBe("running");
    expect((await row(older)).status).toBe("cancelled");
    expect((await row(older)).statusReason).toMatch(/A newer run .* went ahead/);
    await finishOnRunner(newer, { passed: true, pipelines: [] });
    await (await modules()).pass.runCiStatusPass();
  });

  it("puts a retry in its group like any run", async () => {
    const { runs } = await modules();
    const original = await push("retry", "retry-group", true);
    await runs.dispatchRun(original);
    await finishOnRunner(original, { passed: false, pipelines: [] });
    await (await modules()).pass.runCiStatusPass();
    expect((await row(original)).status).toBe("failed");

    const blocker = await push("retry", "retry-group", true);
    await runs.dispatchRun(blocker);
    expect((await row(blocker)).status).toBe("running");

    // The retry is the newest run of the group: it cancels the running one's pipeline.
    const retry = await runs.retryRun(orgId, original, "", { noTaskCache: false });
    await due(retry.id);
    await runs.dispatchRun(retry.id);
    expect((await row(retry.id)).status).toBe("running");
    expect((await row(blocker)).concurrency?.[0]?.cancelled).toBe(true);
    await finishOnRunner(blocker, { passed: false, cancelled: true, pipelines: [] });
    await finishOnRunner(retry.id, { passed: true, pipelines: [] });
    await (await modules()).pass.runCiStatusPass();
    expect((await row(blocker)).status).toBe("cancelled");
    expect((await row(retry.id)).status).toBe("passed");

    // A cancelled run can be retried in turn.
    expect(runs.retryRefusal(await row(blocker))).toBeNull();
  });

  it("cancels a waiting run at once and a running one through its runner", async () => {
    const { runs, pass } = await modules();
    const holder = await push("manual", "manual", false);
    await runs.dispatchRun(holder);
    const waiting = await push("manual", "manual", false);
    await runs.dispatchRun(waiting);
    expect((await row(waiting)).status).toBe("pending");

    const cancelled = await runs.cancelRun(orgId, waiting);
    expect(cancelled.status).toBe("cancelled");
    await expect(runs.cancelRun(orgId, waiting)).rejects.toThrow(/can be cancelled/);

    const running = await runs.cancelRun(orgId, holder);
    expect(running.status).toBe("running");
    expect(running.cancelRequested).toBe(true);
    const r = await row(holder);
    expect(proxy.calls).toContainEqual({
      path: `/v1/runs/${encodeURIComponent(r.proxyRunId ?? "")}/cancel`,
      body: {},
    });
    expect(r.cancelSentAt).not.toBeNull();
    await finishOnRunner(holder, { passed: false, cancelled: true, pipelines: [] });
    await pass.runCiStatusPass();
    expect((await row(holder)).status).toBe("cancelled");
    expect((await row(holder)).statusReason).toBe("Cancelled from Infrawrench.");

    await expect(runs.cancelRun(orgId, randomUUID())).rejects.toThrow(/No such run/);
  });

  it("lets a run whose pipelines name no group go as before", async () => {
    const { runs } = await modules();
    const id = await push("old-runner", "ignored", true);
    proxy.pipelines.delete(sha.toString(16).padStart(40, "0"));
    await runs.dispatchRun(id);
    const r = await row(id);
    expect(r.status).toBe("running");
    expect(r.concurrency).toEqual([]);
    await finishOnRunner(id, { passed: true, pipelines: [] });
    await (await modules()).pass.runCiStatusPass();
  });
});
