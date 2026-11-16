/**
 * Listing CI runs and repositories against a real Postgres: the filters and
 * the page cursor `listRuns` takes for the chat and MCP tools, and
 * `listCiRepositories` beside the CI tab's two listings it shares a query
 * with.
 *
 * Skipped unless DATABASE_URL is set, migrations applied, scratch databases
 * only: it writes an organization, its runs and repositories, and deletes
 * them after.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

const configured = !!process.env["DATABASE_URL"];

const orgId = `test-org-${randomUUID()}`;
const installationId = 920_000_000 + Math.floor(Math.random() * 1_000_000);

describe.skipIf(!configured)("CI run and repository listings, against a real Postgres", () => {
  async function modules() {
    const { db } = await import("../../db/client");
    const schema = await import("../../db/schema");
    const runs = await import("../../ci/runs");
    const schedules = await import("../../ci/schedules");
    return { db, schema, runs, schedules };
  }

  /** Ids by name, so a failure says which run it was. */
  const ids: Record<string, string> = {};

  async function insertRun(
    name: string,
    values: {
      repo?: string;
      event?: "push" | "pull-request" | "schedule" | "manual";
      headRef?: string;
      pullNumber?: number | null;
      status?: "passed" | "failed" | "skipped" | "running";
      createdAt: Date;
    },
  ) {
    const { db, schema } = await modules();
    const id = randomUUID();
    ids[name] = id;
    const repo = values.repo ?? "Acme/Web";
    await db.insert(schema.ciRuns).values({
      id,
      organizationId: orgId,
      installationId,
      repoFullName: repo,
      ownerKey: "github.com-acme",
      repoKey: repo.split("/")[1]!.toLowerCase(),
      event: values.event ?? "push",
      branch: values.pullNumber ? `pull/${values.pullNumber}` : (values.headRef ?? "main"),
      headRef: values.headRef ?? "main",
      defaultBranch: "main",
      sha: "a".repeat(40),
      pullNumber: values.pullNumber ?? null,
      status: values.status ?? "passed",
      dedupeKey: `list-test:${id}`,
      createdAt: values.createdAt,
    });
  }

  const names = (list: Array<{ id: string }>) =>
    list.map((r) => Object.keys(ids).find((k) => ids[k] === r.id));

  afterAll(async () => {
    if (!configured) return;
    const { db, schema } = await modules();
    const { eq } = await import("drizzle-orm");
    await db.delete(schema.ciRuns).where(eq(schema.ciRuns.organizationId, orgId));
    await db.delete(schema.ciSchedules).where(eq(schema.ciSchedules.organizationId, orgId));
    await db.delete(schema.ciAccounts).where(eq(schema.ciAccounts.organizationId, orgId));
    await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    await db.$client.end();
  });

  it("sets up an organization with runs of two repositories", async () => {
    const { db, schema } = await modules();
    await db.insert(schema.organizations).values({ id: orgId, displayName: "CI list test" });
    await db.insert(schema.ciAccounts).values({
      id: randomUUID(),
      organizationId: orgId,
      installationId,
      accountLogin: "acme",
    });
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 16, 10, minute));
    await insertRun("push-main", { createdAt: at(1) });
    await insertRun("pr-7", {
      event: "pull-request",
      headRef: "feat/x",
      pullNumber: 7,
      status: "failed",
      createdAt: at(2),
    });
    await insertRun("skipped", { headRef: "feat/x", status: "skipped", createdAt: at(3) });
    await insertRun("api", { repo: "Acme/Api", createdAt: at(4) });
    // Two runs in the same instant: the cursor must neither repeat nor skip one.
    await insertRun("tie-a", { event: "manual", createdAt: at(5) });
    await insertRun("tie-b", { event: "manual", createdAt: at(5) });
  });

  it("filters by repository in any case, branch, event and pull request", async () => {
    const { runs } = await modules();
    const all = await runs.listRuns(orgId, { limit: 50 });
    expect(all).toHaveLength(5);
    expect(names(all)).not.toContain("skipped");

    expect(names(await runs.listRuns(orgId, { limit: 50, repo: "acme/api" }))).toEqual(["api"]);
    expect(names(await runs.listRuns(orgId, { limit: 50, branch: "feat/x" }))).toEqual(["pr-7"]);
    expect(names(await runs.listRuns(orgId, { limit: 50, pullNumber: 7 }))).toEqual(["pr-7"]);
    expect(
      names(await runs.listRuns(orgId, { limit: 50, event: "pull-request", status: "failed" })),
    ).toEqual(["pr-7"]);
    expect(names(await runs.listRuns(orgId, { limit: 50, status: "skipped" }))).toEqual([
      "skipped",
    ]);
    expect(
      names(await runs.listRuns(orgId, { limit: 50, branch: "feat/x", includeHidden: true })),
    ).toEqual(["skipped", "pr-7"]);
  });

  it("pages with the last run's id, through runs created in the same instant", async () => {
    const { runs } = await modules();
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const list = await runs.listRuns(orgId, {
        limit: 2,
        ...(before ? { beforeRunId: before } : {}),
      });
      seen.push(...list.map((r) => r.id));
      if (list.length < 2) break;
      before = list[list.length - 1]!.id;
    }
    const everything = await runs.listRuns(orgId, { limit: 50 });
    expect(seen).toEqual(everything.map((r) => r.id));
    expect(new Set(seen).size).toBe(5);
    // A run of another organization is no cursor.
    expect(await runs.listRuns(orgId, { limit: 50, beforeRunId: randomUUID() })).toEqual([]);
  });

  it("lists every repository, and the tab's two listings keep their own", async () => {
    const { db, schema, schedules } = await modules();
    const row = (repo: string) => ({
      id: randomUUID(),
      organizationId: orgId,
      installationId,
      repoFullName: repo,
      defaultBranch: "main",
    });
    await db.insert(schema.ciSchedules).values([
      { ...row("Acme/Plain"), manual: [] },
      {
        ...row("Acme/Web"),
        sha: "b".repeat(40),
        pipelines: [{ file: "nightly.yml", name: "Nightly", cron: ["0 3 * * *"], text: "x" }],
        manual: [{ file: "deploy.yml", name: "Deploy", inputs: [] }],
        refreshedAt: new Date(),
      },
      row("Acme/Unread"),
    ]);
    const repos = await schedules.listCiRepositories(orgId);
    expect(repos.map((r) => r.repoFullName)).toEqual(["Acme/Plain", "Acme/Unread", "Acme/Web"]);
    const web = repos.find((r) => r.repoFullName === "Acme/Web")!;
    expect(web.pipelines[0]).toMatchObject({ file: "nightly.yml", cron: ["0 3 * * *"] });
    expect(web.pipelines[0]).not.toHaveProperty("text");
    expect(web.manual).toEqual([{ file: "deploy.yml", name: "Deploy", inputs: [] }]);
    expect(repos.find((r) => r.repoFullName === "Acme/Unread")!.manual).toBeNull();

    const scheduled = await schedules.listCiSchedules(orgId);
    expect(scheduled.schedules.map((r) => r.repoFullName)).toEqual(["Acme/Web"]);
    expect(scheduled.schedules[0]).not.toHaveProperty("manual");
    const manual = await schedules.listCiManualPipelines(orgId);
    expect(manual.repositories.map((r) => r.repoFullName)).toEqual(["Acme/Web"]);
  });
});
