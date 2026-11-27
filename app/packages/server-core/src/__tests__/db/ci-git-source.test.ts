/**
 * CI for a repository on git.infrawrench.com, against a real Postgres: a
 * forge event becomes a run, the run is sent to the runners with the forge's
 * clone URL and a job token for that repository, and its status lands on
 * the commit as commit statuses, never as a GitHub check. A fork's pull
 * request waits, and once approved is still sent without `trusted`. The CI
 * proxy and GitHub are fakes that record what they were asked.
 *
 * Skipped unless DATABASE_URL is set, migrations applied, scratch databases
 * only: it writes an organization and its runs, and deletes them after.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyGitJobToken } from "@infrawrench/client-core";

const configured = !!process.env["DATABASE_URL"];

interface Call {
  path: string;
  body: Record<string, unknown> | null;
}

const fake = {
  proxy: [] as Call[],
  github: [] as Call[],
  concurrency: new Map<string, Record<string, unknown>>(),
  runs: new Map<string, Record<string, unknown>>(),
  next: 0,
  paid: true,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const parse = (init: RequestInit = {}) =>
  init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;

vi.mock("../../entitlements.js", () => ({ planAccess: async () => ({ paid: fake.paid }) }));
vi.mock("../../github/app.js", () => ({
  getInstallationToken: async () => {
    fake.github.push({ path: "installation-token", body: null });
    return "installation-token-for-tests";
  },
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

const KEY = "k".repeat(48);
const orgId = `test-org-${randomUUID()}`;
const userId = `test-user-${randomUUID()}`;
const repositoryId = randomUUID();
const namespace = `acme-${randomUUID().slice(0, 8)}`;
const namespaceId = randomUUID();
const repository = {
  id: repositoryId,
  namespace,
  name: "web",
  defaultBranch: "main",
  organizationId: orgId,
};
const TEST_PIPELINE = { file: ".infrawrench/ci/test.yml", name: "Test", concurrency: null };

describe.skipIf(!configured)(
  "CI for a git.infrawrench.com repository, against a real Postgres",
  () => {
    let sha = 0;
    const statuses: Array<import("../../ci/status").GitCommitStatus> = [];

    async function modules() {
      const { db } = await import("../../db/client");
      const schema = await import("../../db/schema");
      const runs = await import("../../ci/runs");
      const events = await import("../../ci/git-events");
      const repos = await import("../../ci/git-repositories");
      const status = await import("../../ci/status");
      return { db, schema, runs, events, repos, status };
    }

    const nextCommit = () => (++sha).toString(16).padStart(40, "0");

    async function row(id: string) {
      const { db, schema } = await modules();
      const { eq } = await import("drizzle-orm");
      const [r] = await db.select().from(schema.ciRuns).where(eq(schema.ciRuns.id, id));
      if (!r) throw new Error(`no run ${id}`);
      return r;
    }

    /** Makes a run due by this process's clock too, then sends it. */
    async function dispatch(id: string) {
      const { db, schema, runs } = await modules();
      const { eq } = await import("drizzle-orm");
      await db
        .update(schema.ciRuns)
        .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
        .where(eq(schema.ciRuns.id, id));
      await runs.dispatchRun(id);
    }

    const sentRuns = () => fake.proxy.filter((c) => c.path === "/v1/runs");

    beforeEach(async () => {
      fake.proxy = [];
      fake.github = [];
      fake.paid = true;
      statuses.length = 0;
      process.env["GIT_JOB_TOKEN_KEY"] = KEY;
      process.env["APP_URL"] = "https://app.example.test";
      if (configured) {
        const { status } = await modules();
        status.setGitStatusWriter(async (s) => {
          statuses.push(s);
        });
      }
    });

    afterAll(async () => {
      if (!configured) return;
      const { db, schema } = await modules();
      const { eq } = await import("drizzle-orm");
      await db.delete(schema.ciRuns).where(eq(schema.ciRuns.organizationId, orgId));
      await db.delete(schema.ciSchedules).where(eq(schema.ciSchedules.organizationId, orgId));
      await db
        .delete(schema.ciGitRepositories)
        .where(eq(schema.ciGitRepositories.organizationId, orgId));
      await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
      await db.$client.end();
    });

    it("sets up an organization", async () => {
      const { db, schema } = await modules();
      await db.insert(schema.users).values({ id: userId, email: `${userId}@example.test` });
      await db.insert(schema.organizations).values({ id: orgId, displayName: "CI git test" });
      // CI's rows name the repository by a foreign key: the forge's own rows first.
      await db.insert(schema.gitNamespaces).values({
        id: namespaceId,
        slug: namespace,
        slugLower: namespace,
        kind: "org",
        organizationId: orgId,
      });
      await db.insert(schema.gitRepositories).values({
        id: repositoryId,
        namespaceId,
        name: repository.name,
        nameLower: repository.name,
      });
    });

    it("runs a push: forge clone URL, a job token for the repository, a commit status", async () => {
      const { events } = await modules();
      const commit = nextCommit();
      const before = nextCommit();
      fake.concurrency.set(commit, { commit, pipelines: [TEST_PIPELINE], invalid: [] });
      const accepted = await events.acceptGitEvent({
        kind: "push",
        repository,
        ref: "refs/heads/main",
        before,
        after: commit,
        forced: false,
        pusher: "octo",
      });
      expect(accepted?.status).toBe("queued");
      await dispatch(accepted!.id);

      const r = await row(accepted!.id);
      expect(r).toMatchObject({
        status: "running",
        installationId: 0,
        gitRepositoryId: repositoryId,
        repoFullName: `${namespace}/web`,
        ownerKey: `git.infrawrench.com-${namespace}`,
        repoKey: "web",
        event: "push",
        branch: "main",
        baseSha: before,
        fromFork: false,
        actorLogin: "octo",
      });

      const [sent] = sentRuns();
      expect(sent?.body).toMatchObject({
        repo: `https://git.infrawrench.com/${namespace}/web.git`,
        sha: commit,
        branch: "main",
        event: "push",
        owner: `git.infrawrench.com-${namespace}`,
        "repo-id": "web",
        base: before,
      });
      // The pipelines were read with the same repository and credential kind.
      const read = fake.proxy.find((c) => c.path === "/v1/concurrency");
      expect(read?.body?.["repo"]).toBe(`https://git.infrawrench.com/${namespace}/web.git`);
      const token = String(sent?.body?.["token"]);
      expect(await verifyGitJobToken(KEY, token, { repositoryId, access: "read" })).toMatchObject({
        ok: true,
        claims: { runId: accepted!.id },
      });
      expect((await verifyGitJobToken(KEY, token, { access: "write" })).ok).toBe(false);

      // Its status is a commit status; GitHub was asked nothing at all.
      expect(fake.github).toEqual([]);
      expect(statuses.at(-1)).toEqual({
        repositoryId,
        sha: commit,
        context: "Infrawrench CI / push",
        state: "pending",
        description: "Running",
        targetUrl: `https://app.example.test/org/${orgId}/ci/${accepted!.id}`,
        ciRunId: accepted!.id,
      });
    });

    it("makes no second run for the same push delivered again", async () => {
      const { events } = await modules();
      const commit = nextCommit();
      const input = {
        kind: "push" as const,
        repository,
        ref: "refs/heads/feature/x",
        before: null,
        after: commit,
        forced: false,
        created: true,
        pusher: "octo",
      };
      const first = await events.acceptGitEvent(input);
      expect(first).not.toBeNull();
      expect((await row(first!.id)).baseSha).toBeNull();
      expect(await events.acceptGitEvent(input)).toBeNull();
      // Even after the repository is renamed: the key is its id.
      expect(
        await events.acceptGitEvent({ ...input, repository: { ...repository, name: "web" } }),
      ).toBeNull();
    });

    it("finishes a run with a status per job and the run's own", async () => {
      const { events, runs } = await modules();
      const commit = nextCommit();
      fake.concurrency.set(commit, { commit, pipelines: [TEST_PIPELINE], invalid: [] });
      const accepted = await events.acceptGitEvent({
        kind: "push",
        repository,
        ref: "refs/heads/release",
        before: null,
        after: commit,
        forced: false,
        pusher: "octo",
      });
      await dispatch(accepted!.id);
      const running = await row(accepted!.id);
      statuses.length = 0;
      fake.runs.set(running.proxyRunId ?? "", {
        id: running.proxyRunId,
        state: "finished",
        result: {
          passed: false,
          usage: { vcpu_seconds: 1, memory_gib_seconds: 1 },
          pipelines: [
            {
              name: "Test",
              file: TEST_PIPELINE.file,
              outcome: "ran",
              report: {
                pipeline: "Test",
                jobs: [
                  { id: "build", name: "build", status: "passed", duration_ms: 1000 },
                  { id: "lint", name: "lint", status: "failed", duration_ms: 500 },
                ],
              },
            },
          ],
        },
      });
      expect(await runs.syncRun(running)).toBe("ended");
      expect((await row(accepted!.id)).status).toBe("failed");
      expect(statuses.map((s) => [s.context, s.state])).toEqual([
        ["Infrawrench CI / push", "failure"],
        ["Test / build (push)", "success"],
        ["Test / lint (push)", "failure"],
      ]);
      expect(statuses.every((s) => s.sha === commit && s.repositoryId === repositoryId)).toBe(true);
      expect(fake.github).toEqual([]);
    });

    it("holds a fork's pull request for approval, and never sends it trusted", async () => {
      const { events, runs } = await modules();
      const commit = nextCommit();
      const base = nextCommit();
      fake.concurrency.set(commit, { commit, pipelines: [TEST_PIPELINE], invalid: [] });
      const accepted = await events.handleGitEvent({
        kind: "pull_request",
        repository,
        action: "opened",
        number: 12,
        head: {
          sha: commit,
          ref: "main",
          repository: { id: randomUUID(), fullName: "mallory/web" },
        },
        base: { sha: base, ref: "main" },
        actor: "mallory",
      });
      expect(accepted?.status).toBe("awaiting_approval");
      expect(sentRuns()).toEqual([]);
      expect(await row(accepted!.id)).toMatchObject({
        fromFork: true,
        branch: "pull/12",
        headRepoFullName: "mallory/web",
        pullNumber: 12,
      });
      expect(statuses.at(-1)).toMatchObject({
        context: "Infrawrench CI / pull request",
        state: "pending",
        description: "Waiting for a maintainer",
      });

      await runs.approveRun(orgId, accepted!.id, userId);
      await dispatch(accepted!.id);
      const [sent] = sentRuns();
      expect(sent?.body).toMatchObject({
        repo: `https://git.infrawrench.com/${namespace}/web.git`,
        ref: "refs/pull/12/head",
        branch: "pull/12",
        base,
      });
      expect(sent?.body).not.toHaveProperty("trusted");
      expect(sent?.body).not.toHaveProperty("lent");
      expect(sent?.body).not.toHaveProperty("secrets");
    });

    it("sends a pull request of the repository itself trusted", async () => {
      const { events } = await modules();
      const commit = nextCommit();
      fake.concurrency.set(commit, { commit, pipelines: [TEST_PIPELINE], invalid: [] });
      const accepted = await events.acceptGitEvent({
        kind: "pull_request",
        repository,
        action: "synchronize",
        number: 13,
        head: { sha: commit, ref: "feature/y", repository: { id: repositoryId, fullName: "x/y" } },
        base: { sha: nextCommit(), ref: "main" },
        actor: "octo",
      });
      expect(accepted?.status).toBe("queued");
      await dispatch(accepted!.id);
      expect(sentRuns()[0]?.body).toMatchObject({ trusted: true, ref: "refs/pull/13/head" });
    });

    it("closes an older commit's wait when the fork pushes again", async () => {
      const { events } = await modules();
      const fork = { id: randomUUID(), fullName: "mallory/web" };
      const pull = (commit: string) => ({
        kind: "pull_request" as const,
        repository,
        action: "synchronize",
        number: 14,
        head: { sha: commit, ref: "main", repository: fork },
        base: { sha: "f".repeat(40), ref: "main" },
        actor: "mallory",
      });
      const first = await events.acceptGitEvent(pull(nextCommit()));
      const second = await events.acceptGitEvent(pull(nextCommit()));
      expect((await row(first!.id)).status).toBe("rejected");
      expect((await row(second!.id)).status).toBe("awaiting_approval");
    });

    it("lists the run like any other, linked to the forge", async () => {
      const { runs } = await modules();
      const listed = await runs.listRuns(orgId, { limit: 50, includeHidden: true });
      expect(listed.length).toBeGreaterThan(0);
      for (const run of listed) {
        expect(run.source).toBe("git");
        expect(run.repoFullName).toBe(`${namespace}/web`);
        expect(run.sourceUrl?.startsWith(`https://git.infrawrench.com/${namespace}/web/`)).toBe(
          true,
        );
        expect(run.githubUrl).toBe(run.sourceUrl);
      }
      const pushed = listed.find((r) => r.event === "push");
      expect(pushed?.sourceUrl).toBe(
        `https://git.infrawrench.com/${namespace}/web/commit/${pushed?.sha}`,
      );
      const pulled = listed.find((r) => r.pullNumber === 13);
      expect(pulled?.sourceUrl).toBe(
        `https://git.infrawrench.com/${namespace}/web/branches/feature/y`,
      );
    });

    it("retries a run as a run of the same repository", async () => {
      const { runs } = await modules();
      const [failed] = await runs.listRuns(orgId, { limit: 1, status: "failed" });
      const retry = await runs.retryRun(orgId, failed!.id, userId, { noTaskCache: false });
      expect(retry.source).toBe("git");
      expect(await row(retry.id)).toMatchObject({
        gitRepositoryId: repositoryId,
        installationId: 0,
        retryOfRunId: failed!.id,
      });
    });

    it("registers the repository for schedules and manual runs, as a forge repository", async () => {
      const { db, schema } = await modules();
      const { eq } = await import("drizzle-orm");
      const rows = await db
        .select()
        .from(schema.ciSchedules)
        .where(eq(schema.ciSchedules.organizationId, orgId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        installationId: 0,
        gitRepositoryId: repositoryId,
        repoFullName: `${namespace}/web`,
        defaultBranch: "main",
      });
    });

    it("reads its scheduled pipelines from the forge and fires them as forge runs", async () => {
      const { db, schema } = await modules();
      const schedules = await import("../../ci/schedules");
      const { and, eq } = await import("drizzle-orm");
      const head = nextCommit();
      await db
        .update(schema.ciSchedules)
        .set({
          sha: head,
          pipelines: [
            {
              file: ".infrawrench/ci/nightly.yml",
              name: "Nightly",
              cron: ["* * * * *"],
              text: "name: Nightly\n",
            },
          ],
          manual: [],
          firedThrough: null,
        })
        .where(eq(schema.ciSchedules.organizationId, orgId));
      expect((await schedules.listCiSchedules(orgId)).schedules).toMatchObject([
        { installationId: 0, repoFullName: `${namespace}/web` },
      ]);
      expect(await schedules.fireDueSchedules(new Date())).toBeGreaterThanOrEqual(1);
      const [fired] = await db
        .select()
        .from(schema.ciRuns)
        .where(and(eq(schema.ciRuns.organizationId, orgId), eq(schema.ciRuns.event, "schedule")));
      expect(fired).toMatchObject({
        gitRepositoryId: repositoryId,
        installationId: 0,
        ownerKey: `git.infrawrench.com-${namespace}`,
        sha: head,
        branch: "main",
      });
    });

    it("stops running, firing and listing a repository with CI switched off", async () => {
      const { events, repos } = await modules();
      const schedules = await import("../../ci/schedules");
      expect(await repos.setCiGitRepository(repository, false, null)).toMatchObject({
        gitRepositoryId: repositoryId,
        ciEnabled: false,
      });
      const push = {
        kind: "push" as const,
        repository,
        ref: "refs/heads/main",
        before: null,
        after: nextCommit(),
        forced: false,
        pusher: "octo",
      };
      expect(await events.acceptGitEvent(push)).toBeNull();
      expect((await schedules.listCiSchedules(orgId)).schedules).toEqual([]);

      // Switched back on, the next push runs; the setting followed the id.
      await repos.setCiGitRepository(repository, true, null);
      expect(await repos.ciGitRepositoriesOf(orgId)).toEqual([
        {
          gitRepositoryId: repositoryId,
          repoFullName: `${namespace}/web`,
          defaultBranch: "main",
          ciEnabled: true,
        },
      ]);
      expect(await events.acceptGitEvent({ ...push, after: nextCommit() })).not.toBeNull();
    });

    it("records nothing for an organization without a paid plan", async () => {
      const { events } = await modules();
      fake.paid = false;
      expect(
        await events.acceptGitEvent({
          kind: "push",
          repository,
          ref: "refs/heads/main",
          before: null,
          after: nextCommit(),
          forced: false,
          pusher: "octo",
        }),
      ).toBeNull();
    });

    it("leaves a run queued, saying why, when the server cannot sign a job token", async () => {
      const { events } = await modules();
      const commit = nextCommit();
      const accepted = await events.acceptGitEvent({
        kind: "push",
        repository,
        ref: "refs/heads/no-key",
        before: null,
        after: commit,
        forced: false,
        pusher: "octo",
      });
      delete process.env["GIT_JOB_TOKEN_KEY"];
      await dispatch(accepted!.id);
      const r = await row(accepted!.id);
      expect(r.status).toBe("queued");
      expect(r.statusReason).toMatch(/GIT_JOB_TOKEN_KEY/);
      expect(sentRuns()).toEqual([]);
    });
  },
);
