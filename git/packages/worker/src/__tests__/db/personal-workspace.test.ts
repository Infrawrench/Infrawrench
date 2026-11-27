/**
 * A person's own namespace connected to an organisation, against a real
 * Postgres: who may connect it and to what, what the session and the
 * repository's CI settings say, which organisation a push's run is recorded
 * for, and that leaving the organisation ends all of it with nothing else
 * done.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptGitEvent } from "@infrawrench/server-core/ci/git-events";
import {
  auditLogs,
  ciGitRepositories,
  ciRuns,
  ciSchedules,
  gitNamespaces,
  organizationMembers,
} from "@infrawrench/server-core/db/schema";
import { sweepGitWorkspaces } from "@infrawrench/server-core/git/workspace";
import { db, newId } from "../../db/client";
import { getRepositoryById, runsInOrganization } from "../../db/repositories";
import { ciRepository } from "../../events/ci";
import { reviewAvailability } from "../../review/policy";
import { type Person, type World, configured, makeWorld } from "./world";

describe.skipIf(!configured)("a person's namespace connected to an organisation", () => {
  let world: World;
  let alice: Person, bob: Person;
  let acme: { id: string; slug: string };
  let free: { id: string; slug: string };
  let others: { id: string; slug: string };
  let own: { id: string; path: string };
  let sha = 0;

  beforeAll(async () => {
    world = makeWorld();
    [alice, bob] = (await Promise.all(["alice", "bob"].map((name) => world.person(name)))) as [
      Person,
      Person,
    ];
    acme = await world.organization("acme", { paid: true, members: [[alice, "member"]] });
    free = await world.organization("free", { members: [[alice, "owner"]], namespace: false });
    others = await world.organization("others", { paid: true, members: [[bob, "owner"]] });
    own = await world.repository(alice, alice.username, "mine");
  });
  afterAll(async () => {
    if (!world) return;
    for (const organization of [acme, free, others]) {
      await db.delete(ciRuns).where(eq(ciRuns.organizationId, organization.id));
    }
    await world.cleanup();
  });

  const connect = (organizationId: string | null, options: { as?: Person; token?: boolean } = {}) =>
    world.call("PUT", "/api/session/workspace", {
      as: options.as ?? alice,
      ...(options.token ? { scopes: ["repo:read", "repo:write"] as const } : {}),
      body: { organizationId },
    });
  const session = async (as: Person = alice) =>
    (await world.call("GET", "/api/session", { as })).body;
  const stored = async (person: Person = alice) =>
    (
      await db
        .select({ workspace: gitNamespaces.workspaceOrganizationId })
        .from(gitNamespaces)
        .where(eq(gitNamespaces.userId, person.id))
    )[0]?.workspace ?? null;
  /** A push to the repository's `main`, as the queue consumer tells CI of it. */
  const push = async (repositoryId: string = own.id) => {
    const repo = (await getRepositoryById(repositoryId))!;
    return acceptGitEvent({
      kind: "push",
      repository: ciRepository(repo),
      ref: "refs/heads/main",
      before: null,
      after: (++sha).toString(16).padStart(40, "0"),
      forced: false,
      pusher: alice.username,
    });
  };
  const runRow = async (id: string) =>
    (await db.select().from(ciRuns).where(eq(ciRuns.id, id)))[0]!;

  it("starts unconnected: no CI, no review agents, and the session says which organisations pay", async () => {
    const me = await session();
    expect(me.personal.workspace).toBeNull();
    const paid = Object.fromEntries(
      (me.organizations as Array<{ id: string; paid: boolean }>).map((o) => [o.id, o.paid]),
    );
    expect(paid).toEqual({ [acme.id]: true, [free.id]: false });

    expect(await push()).toBeNull();
    const repo = (await getRepositoryById(own.id))!;
    expect(runsInOrganization(repo.owner)).toBeNull();
    expect(reviewAvailability(repo, true)).toMatchObject({ available: false });
    expect((await world.call("GET", `${own.path}/ci/settings`, { as: alice })).body).toEqual({
      enabled: true,
      available: false,
      appUrl: null,
    });
    expect((await world.call("GET", `${own.path}/ci`, { as: alice })).body).toMatchObject({
      enabled: false,
      reason: expect.stringContaining("Settings > Profile"),
    });
  });

  it("is connected by its owner, in a browser, to an organisation they belong to and no other", async () => {
    expect(await connect(others.id)).toMatchObject({
      status: 403,
      body: { code: "not_a_member" },
    });
    expect(await connect("no-such-organisation")).toMatchObject({
      status: 403,
      body: { code: "not_a_member" },
    });
    // A token never says who pays.
    expect((await connect(acme.id, { token: true })).status).toBe(403);
    expect(
      (await world.call("PUT", "/api/session/workspace", { body: { organizationId: acme.id } }))
        .status,
    ).toBe(401);
    expect(await stored()).toBeNull();

    const connected = await connect(acme.id);
    expect(connected).toMatchObject({
      status: 200,
      body: { workspace: { id: acme.id, name: "acme" } },
    });
    expect(await stored()).toBe(acme.id);
    expect((await session()).personal.workspace).toEqual({ id: acme.id, name: "acme" });
    // Bob's namespace is his own: nothing of Alice's choice reaches it.
    expect(await stored(bob)).toBeNull();
    // The organisation that now pays has it in its audit log.
    const audited = await db
      .select({ action: auditLogs.action, userId: auditLogs.userId })
      .from(auditLogs)
      .where(and(eq(auditLogs.organizationId, acme.id), eq(auditLogs.entityType, "git_namespace")));
    expect(audited).toContainEqual({ action: "git.workspace.connect", userId: alice.id });
  });

  it("runs a push as the organisation's run, under the person's own owner key", async () => {
    const accepted = await push();
    expect(accepted?.status).toBe("queued");
    expect(await runRow(accepted!.id)).toMatchObject({
      organizationId: acme.id,
      gitRepositoryId: own.id,
      // Secrets, variables and caches are kept per owner key: the person's
      // namespace, never the organisation's.
      ownerKey: `git.infrawrench.com-${alice.username.toLowerCase()}`,
      repoFullName: `${alice.username}/mine`,
      fromFork: false,
    });
    expect(ciRepository((await getRepositoryById(own.id))!).organizationId).toBeNull();

    const repo = (await getRepositoryById(own.id))!;
    expect(runsInOrganization(repo.owner)).toBe(acme.id);
    expect(reviewAvailability(repo, true)).toEqual({ available: true, organizationId: acme.id });
    expect((await world.call("GET", `${own.path}/ci/settings`, { as: alice })).body).toEqual({
      enabled: true,
      available: true,
      appUrl: `https://app.example.test/org/${acme.id}/ci`,
    });
    // Someone who is not in the organisation is shown no way into it.
    expect((await world.call("GET", `${own.path}/ci/settings`, { as: bob })).status).toBe(403);
    const listed = await world.call("GET", `${own.path}/ci/runs`, { as: bob });
    expect(listed.body.items.map((run: { id: string }) => run.id)).toEqual([accepted!.id]);
  });

  it("does not run in an organisation without a paid plan", async () => {
    expect((await connect(free.id)).status).toBe(200);
    // What CI kept for the organisation it left is gone with the connection.
    expect(
      await db
        .select()
        .from(ciGitRepositories)
        .where(eq(ciGitRepositories.gitRepositoryId, own.id)),
    ).toEqual([]);
    expect(
      await db.select().from(ciSchedules).where(eq(ciSchedules.gitRepositoryId, own.id)),
    ).toEqual([]);
    expect(await push()).toBeNull();
    expect((await world.call("GET", `${own.path}/ci`, { as: alice })).body).toMatchObject({
      enabled: false,
      reason: "CI needs a paid plan",
    });
    expect((await connect(acme.id)).status).toBe(200);
    expect((await push())?.status).toBe("queued");
  });

  it("ends when the person leaves the organisation, with nothing else done", async () => {
    await db
      .delete(organizationMembers)
      .where(
        and(
          eq(organizationMembers.userId, alice.id),
          eq(organizationMembers.organizationId, acme.id),
        ),
      );
    // The column still names it; nothing reads it as a connection.
    expect(await stored()).toBe(acme.id);
    expect(await push()).toBeNull();
    const repo = (await getRepositoryById(own.id))!;
    expect(runsInOrganization(repo.owner)).toBeNull();
    expect(reviewAvailability(repo, true)).toMatchObject({ available: false });
    expect((await world.call("GET", `${own.path}/ci/settings`, { as: alice })).body).toMatchObject({
      available: false,
      appUrl: null,
    });
    // Their runs there are no longer theirs to read.
    expect((await world.call("GET", `${own.path}/ci/runs`, { as: alice })).body.items).toEqual([]);

    // Loading the session clears what is left, in the background.
    expect((await session()).personal.workspace).toBeNull();
    expect(await stored()).toBeNull();
    expect(
      await db
        .select()
        .from(ciGitRepositories)
        .where(eq(ciGitRepositories.gitRepositoryId, own.id)),
    ).toEqual([]);
    // And they cannot connect it again.
    expect((await connect(acme.id)).status).toBe(403);
  });

  it("is swept by the poller for someone who never comes back", async () => {
    await db
      .insert(organizationMembers)
      .values({ id: newId(), userId: alice.id, organizationId: acme.id, role: "member" });
    expect((await connect(acme.id)).status).toBe(200);
    expect((await push())?.status).toBe("queued");
    await db
      .delete(organizationMembers)
      .where(
        and(
          eq(organizationMembers.userId, alice.id),
          eq(organizationMembers.organizationId, acme.id),
        ),
      );
    expect(await sweepGitWorkspaces()).toBeGreaterThanOrEqual(1);
    expect(await stored()).toBeNull();
    expect(
      await db
        .select()
        .from(ciGitRepositories)
        .where(eq(ciGitRepositories.gitRepositoryId, own.id)),
    ).toEqual([]);
    expect(await sweepGitWorkspaces()).toBe(0);
  });

  it("is asked with the username, and a refusal claims nothing", async () => {
    const carol = await world.person("carol", { username: false });
    // git-feature-flag: sign-ups are for members of an organisation that has Git.
    const hers = await world.organization("carolco", {
      paid: true,
      members: [[carol, "member"]],
      namespace: false,
      git: true,
    });
    const claim = (workspaceOrganizationId: string | null | undefined) =>
      world.call("POST", "/api/session/username", {
        as: carol,
        body: {
          username: carol.username,
          ...(workspaceOrganizationId === undefined ? {} : { workspaceOrganizationId }),
        },
      });
    expect(await claim(others.id)).toMatchObject({ status: 403, body: { code: "not_a_member" } });
    expect((await session(carol)).user.username).toBeNull();

    expect((await claim(hers.id)).status).toBe(200);
    const me = await session(carol);
    expect(me.user.username).toBe(carol.username);
    expect(me.personal.workspace).toEqual({ id: hers.id, name: "carolco" });

    // "None" is an answer too.
    const dave = await world.person("dave", { username: false });
    await world.organization("daveco", {
      paid: true,
      members: [[dave, "member"]],
      namespace: false,
      git: true,
    });
    expect(
      (
        await world.call("POST", "/api/session/username", {
          as: dave,
          body: { username: dave.username, workspaceOrganizationId: null },
        })
      ).status,
    ).toBe(200);
    expect((await session(dave)).personal.workspace).toBeNull();
  });
});
