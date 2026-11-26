/**
 * "Start work with Infrawrench" against a real Postgres: which pull requests
 * an organisation's agent session may work on, the one refusal for every
 * other, and the agent link that names the session on the forge.
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

describe.skipIf(!configured)("agent work on a git.infrawrench.com pull request", () => {
  async function modules() {
    const { db } = await import("../../db/client");
    const schema = await import("../../db/schema");
    const work = await import("../../git/agent-work");
    return { db, schema, work };
  }

  /** A pull request (and its issue row) numbered `number` in `repositoryId`. */
  async function pull(
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
    // Namespaces cascade to repositories, issues, pull requests and links.
    await db
      .delete(schema.organizations)
      .where(inArray(schema.organizations.id, [orgId, otherOrgId, flaglessOrgId]));
    await db.delete(schema.users).where(inArray(schema.users.id, [userId]));
    await db.$client.end();
  });

  let pullRequestId = "";

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
    pullRequestId = await pull(ids.repo, 1);
    await pull(ids.repo, 2, { state: "closed" });
    await pull(ids.repo, 3, { headRepositoryId: ids.fork });
    await pull(ids.repo, 4, { headRepositoryId: null });
    await pull(ids.archived, 1);
    await pull(ids.otherRepo, 1);
    await pull(ids.flaglessRepo, 1);
    // An issue numbered 5 that is not a pull request.
    await db.insert(schema.gitIssues).values({
      id: randomUUID(),
      repositoryId: ids.repo,
      number: 5,
      title: "Just an issue",
    });
  });

  it("resolves an open pull request of the organisation's repository, by any case", async () => {
    const { work } = await modules();
    const resolved = await work.resolveGitWork(orgId, {
      owner: namespace.toUpperCase(),
      repo: "INFRA",
      pull: 1,
    });
    expect(resolved).toMatchObject({
      organizationId: orgId,
      repositoryId: ids.repo,
      pullRequestId,
      owner: namespace,
      repo: "Infra",
      pull: 1,
      branch: "work/ask-1",
      ref: "refs/heads/work/ask-1",
      title: "Ask 1",
      body: "Do thing 1.",
      cloneUrl: `https://git.infrawrench.com/${namespace}/Infra.git`,
      pullUrl: `https://git.infrawrench.com/${namespace}/Infra/pull/1`,
    });
  });

  it("refuses everything else with the one refusal", async () => {
    const { work } = await modules();
    const refused = [
      [orgId, { owner: namespace, repo: "infra", pull: 2 }], // closed
      [orgId, { owner: namespace, repo: "infra", pull: 3 }], // from a fork
      [orgId, { owner: namespace, repo: "infra", pull: 4 }], // its fork was deleted
      [orgId, { owner: namespace, repo: "infra", pull: 5 }], // an issue
      [orgId, { owner: namespace, repo: "infra", pull: 99 }], // missing
      [orgId, { owner: namespace, repo: "old", pull: 1 }], // archived
      [orgId, { owner: namespace, repo: "nothing", pull: 1 }], // no such repository
      [orgId, { owner: otherNamespace, repo: "infra", pull: 1 }], // another organisation's
      [otherOrgId, { owner: namespace, repo: "infra", pull: 1 }], // asked by another organisation
      [flaglessOrgId, { owner: flaglessNamespace, repo: "infra", pull: 1 }], // Git off
      [orgId, { owner: "../x", repo: "infra", pull: 1 }], // not an address
      [orgId, { owner: namespace, repo: "infra", pull: 0 }],
    ] as const;
    for (const [organizationId, request] of refused) {
      const error = await work.resolveGitWork(organizationId, request).catch((e: unknown) => e);
      expect(error, JSON.stringify(request)).toBeInstanceOf(work.GitWorkUnavailable);
      expect((error as Error).message).toBe(
        "There is no open pull request to work on at that address.",
      );
    }
  });

  it("names the session as the pull request's agent, and finds the work from it", async () => {
    const { db, schema, work } = await modules();
    const { eq } = await import("drizzle-orm");
    const resolved = await work.resolveGitWork(orgId, { owner: namespace, repo: "infra", pull: 1 });
    const sessionId = randomUUID();
    await work.recordAgentLink({ work: resolved, sessionId, userId });
    const [link] = await db
      .select()
      .from(schema.gitAgentLinks)
      .where(eq(schema.gitAgentLinks.pullRequestId, pullRequestId));
    expect(link).toMatchObject({
      repositoryId: ids.repo,
      kind: "infrawrench",
      displayName: "Infrawrench agent",
      externalRefs: { sessionId, organizationId: orgId },
      connectedByUserId: userId,
    });
    expect(await work.gitWorkForSession(orgId, sessionId)).toMatchObject({
      pullRequestId,
      ref: "refs/heads/work/ask-1",
    });
    // Another organisation, or another session, finds nothing.
    expect(await work.gitWorkForSession(otherOrgId, sessionId)).toBeNull();
    expect(await work.gitWorkForSession(orgId, randomUUID())).toBeNull();

    // A second session takes the pull request over.
    const next = randomUUID();
    await work.recordAgentLink({ work: resolved, sessionId: next, userId: null });
    expect(await work.gitWorkForSession(orgId, sessionId)).toBeNull();
    expect(await work.gitWorkForSession(orgId, next)).not.toBeNull();

    // Once the pull request closes there is no work, so no new token.
    await db
      .update(schema.gitIssues)
      .set({ state: "closed" })
      .where(eq(schema.gitIssues.id, pullRequestId));
    expect(await work.gitWorkForSession(orgId, next)).toBeNull();
  });
});
