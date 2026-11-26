/**
 * "Start work with Infrawrench" against a real Postgres: which branch pages
 * an organisation's agent session may work on, by their keys, the one
 * refusal for every other, and the agent link that names the session on the
 * forge.
 *
 * Skipped unless DATABASE_URL is set, migrations applied, scratch databases
 * only: it writes two organisations and their forge rows, and deletes them
 * after.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

const configured = !!process.env["DATABASE_URL"];

const orgId = `test-org-${randomUUID()}`;
const otherOrgId = `test-org-${randomUUID()}`;
const flaglessOrgId = `test-org-${randomUUID()}`;
const userId = `test-user-${randomUUID()}`;
const suffix = randomUUID().slice(0, 8);
const namespace = `acme-${suffix}`;
const otherNamespace = `other-${suffix}`;
const flaglessNamespace = `noflag-${suffix}`;
const ids = {
  namespace: randomUUID(),
  otherNamespace: randomUUID(),
  flaglessNamespace: randomUUID(),
  repo: randomUUID(),
  fork: randomUUID(),
  archived: randomUUID(),
  otherRepo: randomUUID(),
  flaglessRepo: randomUUID(),
};
const OID = "a".repeat(40);

describe.skipIf(!configured)("agent work on a git.infrawrench.com branch page", () => {
  async function modules() {
    const { db } = await import("../../db/client");
    const schema = await import("../../db/schema");
    const work = await import("../../git/agent-work");
    return { db, schema, work };
  }

  /** A branch page (its thread and page rows) numbered `number` in `repositoryId`. */
  async function page(
    repositoryId: string,
    number: number,
    opts: { state?: "open" | "closed"; headRepositoryId?: string | null; headRef?: string } = {},
  ) {
    const { db, schema } = await modules();
    const issueId = randomUUID();
    await db.insert(schema.gitIssues).values({
      id: issueId,
      repositoryId,
      number,
      isPullRequest: true,
      title: `Ask ${number}`,
      body: `Do thing ${number}.`,
      state: opts.state ?? "open",
    });
    await db.insert(schema.gitPullRequests).values({
      issueId,
      repositoryId,
      baseRef: "main",
      headRepositoryId: opts.headRepositoryId === undefined ? repositoryId : opts.headRepositoryId,
      headRef: opts.headRef ?? `work/ask-${number}`,
      headOid: OID,
      baseOid: OID,
    });
    return issueId;
  }

  afterAll(async () => {
    if (!configured) return;
    const { db, schema } = await modules();
    const { inArray } = await import("drizzle-orm");
    // Namespaces cascade to repositories, threads, pages and links.
    await db
      .delete(schema.organizations)
      .where(inArray(schema.organizations.id, [orgId, otherOrgId, flaglessOrgId]));
    await db.delete(schema.users).where(inArray(schema.users.id, [userId]));
    await db.$client.end();
  });

  let pageId = "";
  let reusedOpenId = "";

  it("sets up two organisations with Git and one without", async () => {
    const { db, schema } = await modules();
    await db.insert(schema.users).values({ id: userId, email: `${userId}@example.test` });
    await db.insert(schema.organizations).values([
      { id: orgId, displayName: "Agent work" },
      { id: otherOrgId, displayName: "Someone else" },
      { id: flaglessOrgId, displayName: "No Git" },
    ]);
    await db
      .insert(schema.gitFeatureAccess)
      .values([{ organizationId: orgId }, { organizationId: otherOrgId }]);
    await db.insert(schema.gitNamespaces).values([
      {
        id: ids.namespace,
        slug: namespace,
        slugLower: namespace,
        kind: "org",
        organizationId: orgId,
      },
      {
        id: ids.otherNamespace,
        slug: otherNamespace,
        slugLower: otherNamespace,
        kind: "org",
        organizationId: otherOrgId,
      },
      {
        id: ids.flaglessNamespace,
        slug: flaglessNamespace,
        slugLower: flaglessNamespace,
        kind: "org",
        organizationId: flaglessOrgId,
      },
    ]);
    await db.insert(schema.gitRepositories).values([
      { id: ids.repo, namespaceId: ids.namespace, name: "Infra", nameLower: "infra" },
      { id: ids.fork, namespaceId: ids.namespace, name: "fork", nameLower: "fork", isFork: true },
      {
        id: ids.archived,
        namespaceId: ids.namespace,
        name: "old",
        nameLower: "old",
        archived: true,
      },
      { id: ids.otherRepo, namespaceId: ids.otherNamespace, name: "infra", nameLower: "infra" },
      {
        id: ids.flaglessRepo,
        namespaceId: ids.flaglessNamespace,
        name: "infra",
        nameLower: "infra",
      },
    ]);
    pageId = await page(ids.repo, 1);
    await page(ids.repo, 2, { state: "closed" });
    await page(ids.repo, 3, { headRepositoryId: ids.fork });
    await page(ids.repo, 4, { headRepositoryId: null });
    // A name used twice: the first page closed, the second open.
    await page(ids.repo, 6, { state: "closed", headRef: "work/reused" });
    reusedOpenId = await page(ids.repo, 7, { headRef: "work/reused" });
    // A name whose every page closed.
    await page(ids.repo, 8, { state: "closed", headRef: "work/old" });
    await page(ids.repo, 9, { state: "closed", headRef: "work/old" });
    // A fork's branch of the same name as page 1's: not what `work/ask-1` names.
    await page(ids.repo, 10, { headRepositoryId: ids.fork, headRef: "work/ask-1" });
    await page(ids.archived, 1);
    await page(ids.otherRepo, 1);
    await page(ids.flaglessRepo, 1);
    // An issue numbered 5 that is no branch page.
    await db.insert(schema.gitIssues).values({
      id: randomUUID(),
      repositoryId: ids.repo,
      number: 5,
      title: "Just an issue",
    });
  });

  it("resolves an open branch page of the organisation's repository, by any case", async () => {
    const { work } = await modules();
    const resolved = await work.resolveGitWork(orgId, {
      owner: namespace.toUpperCase(),
      repo: "INFRA",
      branch: "work/ask-1",
    });
    expect(resolved).toMatchObject({
      organizationId: orgId,
      repositoryId: ids.repo,
      pageId,
      owner: namespace,
      repo: "Infra",
      key: "work/ask-1",
      branch: "work/ask-1",
      ref: "refs/heads/work/ask-1",
      title: "Ask 1",
      body: "Do thing 1.",
      cloneUrl: `https://git.infrawrench.com/${namespace}/Infra.git`,
      pageUrl: `https://git.infrawrench.com/${namespace}/Infra/branches/work/ask-1`,
    });
  });

  it("resolves a name used again to its open page, bare or by its place", async () => {
    const { work } = await modules();
    for (const branch of ["work/reused", "work/reused~2"]) {
      expect(
        await work.resolveGitWork(orgId, { owner: namespace, repo: "infra", branch }),
        branch,
      ).toMatchObject({ pageId: reusedOpenId, key: "work/reused", branch: "work/reused" });
    }
  });

  it("refuses everything else with the one refusal", async () => {
    const { work } = await modules();
    const refused = [
      [orgId, { owner: namespace, repo: "infra", branch: "work/ask-2" }], // closed
      [orgId, { owner: namespace, repo: "infra", branch: "work/ask-3" }], // only a fork's
      [orgId, { owner: namespace, repo: "infra", branch: `${namespace}/fork:work/ask-3` }], // a fork's
      [orgId, { owner: namespace, repo: "infra", branch: "-:work/ask-4" }], // its fork was deleted
      [orgId, { owner: namespace, repo: "infra", branch: "work/ask-4" }],
      [orgId, { owner: namespace, repo: "infra", branch: "work/reused~1" }], // an older, closed page
      [orgId, { owner: namespace, repo: "infra", branch: "work/reused~3" }], // no third page
      [orgId, { owner: namespace, repo: "infra", branch: "work/old" }], // every page closed
      [orgId, { owner: namespace, repo: "infra", branch: "work/ask-99" }], // missing
      [orgId, { owner: namespace, repo: "old", branch: "work/ask-1" }], // archived
      [orgId, { owner: namespace, repo: "nothing", branch: "work/ask-1" }], // no such repository
      [orgId, { owner: otherNamespace, repo: "infra", branch: "work/ask-1" }], // another organisation's
      [otherOrgId, { owner: namespace, repo: "infra", branch: "work/ask-1" }], // asked by another organisation
      [flaglessOrgId, { owner: flaglessNamespace, repo: "infra", branch: "work/ask-1" }], // Git off
      [orgId, { owner: "../x", repo: "infra", branch: "work/ask-1" }], // not an address
      [orgId, { owner: namespace, repo: "infra", branch: "a:b:c" }], // not a key
      [orgId, { owner: namespace, repo: "infra", branch: "" }],
    ] as const;
    for (const [organizationId, request] of refused) {
      const error = await work.resolveGitWork(organizationId, request).catch((e: unknown) => e);
      expect(error, JSON.stringify(request)).toBeInstanceOf(work.GitWorkUnavailable);
      expect((error as Error).message).toBe(
        "There is no open branch page to work on at that address.",
      );
    }
  });

  it("names the session as the page's agent, and finds the work from it", async () => {
    const { db, schema, work } = await modules();
    const { eq } = await import("drizzle-orm");
    const resolved = await work.resolveGitWork(orgId, {
      owner: namespace,
      repo: "infra",
      branch: "work/ask-1",
    });
    const sessionId = randomUUID();
    await work.recordAgentLink({ work: resolved, sessionId, userId });
    const [link] = await db
      .select()
      .from(schema.gitAgentLinks)
      .where(eq(schema.gitAgentLinks.pullRequestId, pageId));
    expect(link).toMatchObject({
      repositoryId: ids.repo,
      kind: "infrawrench",
      displayName: "Infrawrench agent",
      externalRefs: { sessionId, organizationId: orgId },
      connectedByUserId: userId,
    });
    expect(await work.gitWorkForSession(orgId, sessionId)).toMatchObject({
      pageId,
      key: "work/ask-1",
      ref: "refs/heads/work/ask-1",
    });
    // Another organisation, or another session, finds nothing.
    expect(await work.gitWorkForSession(otherOrgId, sessionId)).toBeNull();
    expect(await work.gitWorkForSession(orgId, randomUUID())).toBeNull();

    // A second session takes the page over.
    const next = randomUUID();
    await work.recordAgentLink({ work: resolved, sessionId: next, userId: null });
    expect(await work.gitWorkForSession(orgId, sessionId)).toBeNull();
    expect(await work.gitWorkForSession(orgId, next)).not.toBeNull();

    // Once the page closes there is no work, so no new token.
    await db
      .update(schema.gitIssues)
      .set({ state: "closed" })
      .where(eq(schema.gitIssues.id, pageId));
    expect(await work.gitWorkForSession(orgId, next)).toBeNull();
  });
});
