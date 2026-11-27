/**
 * Infrawrench CI on the free plan, against a real Postgres and the real
 * plan check (`planAccess` is not mocked here): an organization with no
 * subscription cannot turn CI on, and one that was running it when its plan
 * ended sends nothing to the runners, whichever way a run is asked for (a
 * push, a schedule, by hand, a retry, an approval). The CI proxy and GitHub
 * are fakes that record what they were asked.
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

const fake = { proxy: [] as Call[], github: [] as Call[] };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const parse = (init: RequestInit = {}) =>
  init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;

vi.mock("../../github/app.js", () => ({
  isGithubAppConfigured: () => true,
  getInstallationToken: async () => "installation-token-for-tests",
  githubInstallationFetch: async (_installation: number, path: string, init?: RequestInit) => {
    fake.github.push({ path, body: parse(init) });
    return json(201, { id: 4242 });
  },
}));
vi.mock("../../ci/proxy.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../ci/proxy.js")>();
  const proxyFetch = async (path: string, init: RequestInit = {}) => {
    fake.proxy.push({ path, body: parse(init) });
    if (path === "/v1/concurrency") return json(200, { pipelines: [] });
    return json(200, {});
  };
  return {
    ...real,
    ciProxyConfigured: () => true,
    proxyFetch,
    proxyJson: async (path: string, init?: RequestInit) => (await proxyFetch(path, init)).json(),
  };
});

const orgId = `test-org-${randomUUID()}`;
const userId = `test-user-${randomUUID()}`;
const installationId = 920_000_000 + Math.floor(Math.random() * 1_000_000);
const repo = "Acme/Web";
const PLAN_REFUSAL = "Infrawrench CI is part of Pro. Upgrade under Settings → Billing.";

describe.skipIf(!configured)("CI on the free plan, against a real Postgres", () => {
  let sha = 0;
  let erroredRun = "";

  async function modules() {
    const { db } = await import("../../db/client");
    const schema = await import("../../db/schema");
    const runs = await import("../../ci/runs");
    const accounts = await import("../../ci/accounts");
    const schedules = await import("../../ci/schedules");
    const values = await import("../../ci/values");
    const { PlanRequiredError } = await import("../../entitlements");
    return { db, schema, runs, accounts, schedules, values, PlanRequiredError };
  }

  async function runsOfOrg() {
    const { db, schema } = await modules();
    const { eq } = await import("drizzle-orm");
    return db.select().from(schema.ciRuns).where(eq(schema.ciRuns.organizationId, orgId));
  }

  /** A push of a new commit, recorded and handed to the dispatcher. */
  async function push(): Promise<string> {
    const { runs, db, schema } = await modules();
    const { eq } = await import("drizzle-orm");
    const accepted = await runs.acceptCiEvent({
      kind: "push",
      baseSha: null,
      installationId,
      repoFullName: repo,
      branch: "main",
      sha: (++sha).toString(16).padStart(40, "0"),
      defaultBranch: "main",
      actorLogin: "octocat",
    });
    if (!accepted) throw new Error("not accepted");
    await db
      .update(schema.ciRuns)
      .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.ciRuns.id, accepted.id));
    await runs.dispatchRun(accepted.id);
    return accepted.id;
  }

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
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.$client.end();
  });

  it("does not turn CI on for a free organization, and says the plan is why", async () => {
    const { db, schema, accounts, PlanRequiredError } = await modules();
    const { eq } = await import("drizzle-orm");
    await db.insert(schema.users).values({ id: userId, email: `${userId}@example.test` });
    await db.insert(schema.organizations).values({ id: orgId, displayName: "Free CI test" });
    await db.insert(schema.githubInstallations).values({
      id: randomUUID(),
      organizationId: orgId,
      installationId,
      accountLogin: "acme",
    } as typeof schema.githubInstallations.$inferInsert);

    const refusal = await accounts.setCiAccount(orgId, installationId, true, userId).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(PlanRequiredError);
    expect(refusal).toMatchObject({ status: 402, message: PLAN_REFUSAL });
    expect(
      await db.select().from(schema.ciAccounts).where(eq(schema.ciAccounts.organizationId, orgId)),
    ).toEqual([]);

    const status = await accounts.ciStatus(orgId);
    expect(status.planIncludesCi).toBe(false);
    expect(status.accounts).toMatchObject([{ installationId, ciEnabled: false }]);
  });

  it("ignores a push while no account runs CI", async () => {
    const { runs } = await modules();
    expect(
      await runs.acceptCiEvent({
        kind: "push",
        baseSha: null,
        installationId,
        repoFullName: repo,
        branch: "main",
        sha: "e".repeat(40),
        defaultBranch: "main",
        actorLogin: "octocat",
      }),
    ).toBeNull();
    expect(await runsOfOrg()).toEqual([]);
  });

  it("sends nothing to the runners for an organization whose plan ended", async () => {
    // It turned CI on while it paid: the account's row outlives the plan.
    const { db, schema } = await modules();
    await db.insert(schema.ciAccounts).values({
      id: randomUUID(),
      organizationId: orgId,
      installationId,
      accountLogin: "acme",
    });

    erroredRun = await push();
    const [row] = (await runsOfOrg()).filter((r) => r.id === erroredRun);
    expect(row).toMatchObject({
      status: "error",
      statusReason: "CI needs a paid plan.",
      proxyRunId: null,
    });
    // Not even the question of what would run reached a runner.
    expect(fake.proxy).toEqual([]);
    // The commit says why, as a neutral check rather than a failure.
    const checks = fake.github.filter((c) => c.path.includes("/check-runs"));
    expect(checks.at(-1)?.body).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      output: { title: "Not run", summary: "CI needs a paid Infrawrench plan." },
    });
  });

  it("fires no schedule", async () => {
    const { db, schema, schedules } = await modules();
    const { and, eq } = await import("drizzle-orm");
    // The push noted the repository; say its default branch has a pipeline
    // due every minute and one to start by hand, as a read would.
    const noted = await db
      .update(schema.ciSchedules)
      .set({
        sha: "b".repeat(40),
        pipelines: [{ file: "nightly.yml", name: "Nightly", cron: ["* * * * *"], text: "x" }],
        manual: [{ file: "deploy.yml", name: "Deploy", inputs: [] }],
        refreshedAt: new Date(),
        firedThrough: new Date(Date.now() - 5 * 60_000),
      })
      .where(
        and(
          eq(schema.ciSchedules.organizationId, orgId),
          eq(schema.ciSchedules.repoFullName, repo),
        ),
      )
      .returning({ id: schema.ciSchedules.id });
    expect(noted).toHaveLength(1);
    const before = (await runsOfOrg()).length;
    await schedules.fireDueSchedules();
    const after = await runsOfOrg();
    expect(after).toHaveLength(before);
    expect(after.filter((r) => r.event === "schedule")).toEqual([]);
    expect(fake.proxy).toEqual([]);
  });

  it("refuses a run by hand, a retry, an approval and a secret", async () => {
    const { runs, values, PlanRequiredError } = await modules();
    const before = (await runsOfOrg()).length;
    const asked: Array<() => Promise<unknown>> = [
      () =>
        runs.startManualRun(orgId, userId, "octocat", {
          installationId,
          repoFullName: repo,
          pipelineFile: "deploy.yml",
        }),
      () => runs.retryRun(orgId, erroredRun, userId, { noTaskCache: false }),
      () => runs.approveRun(orgId, erroredRun, userId),
      () => values.setCiValue(orgId, installationId, null, "secrets", "NPM_TOKEN", "value"),
    ];
    for (const call of asked) {
      const refusal = await call().then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(PlanRequiredError);
      expect(refusal).toMatchObject({ status: 402, message: PLAN_REFUSAL });
    }
    expect(await runsOfOrg()).toHaveLength(before);
    expect(fake.proxy).toEqual([]);
  });

  it("still lets it stop: the account is turned off without a plan", async () => {
    const { db, schema, accounts } = await modules();
    const { eq } = await import("drizzle-orm");
    await expect(
      accounts.setCiAccount(orgId, installationId, false, userId),
    ).resolves.toMatchObject({ ciEnabled: false });
    expect(
      await db.select().from(schema.ciAccounts).where(eq(schema.ciAccounts.organizationId, orgId)),
    ).toEqual([]);
  });

  it("runs once the organization has a plan", async () => {
    const { db, schema, accounts, runs } = await modules();
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.organizations)
      .set({ complimentary: true })
      .where(eq(schema.organizations.id, orgId));
    expect((await accounts.ciStatus(orgId)).planIncludesCi).toBe(true);
    await expect(accounts.setCiAccount(orgId, installationId, true, userId)).resolves.toMatchObject(
      { ciEnabled: true },
    );

    const retried = await runs.retryRun(orgId, erroredRun, userId, { noTaskCache: false });
    expect(retried).toMatchObject({ status: "queued", retryOfRunId: erroredRun });
    // And a push now asks the runners what to run.
    await push();
    expect(fake.proxy.map((c) => c.path)).toContain("/v1/concurrency");
    // And the schedule that passed unfired is fired.
    const { schedules } = await modules();
    await db
      .update(schema.ciSchedules)
      .set({ firedThrough: new Date(Date.now() - 5 * 60_000) })
      .where(eq(schema.ciSchedules.organizationId, orgId));
    await schedules.fireDueSchedules();
    expect((await runsOfOrg()).filter((r) => r.event === "schedule").length).toBeGreaterThan(0);
  });
});
