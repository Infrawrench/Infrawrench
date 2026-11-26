/**
 * Where one repository's or one organisation's things stop, against a real
 * Postgres: a pull request's head comes from the base's fork network and
 * never carries a private repository's commits to its readers' outside; a
 * transfer leaves the old organisation's accounts behind; a personal token
 * without `repo:write` writes nothing, and no token renames its person.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { accounts, gitTerraformWorkspaceAccounts } from "@infrawrench/server-core/db/schema";
import { db, newId } from "../../db/client";
import { type Person, type World, configured, makeWorld } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));
vi.mock("../../events/terraform", () => ({
  queuePullRequestPlans: vi.fn(async () => {}),
  queueMergeApplies: vi.fn(async () => {}),
}));

describe.skipIf(!configured)("access boundaries, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person, erin: Person;
  let acme: { id: string; slug: string }, beta: { id: string; slug: string };

  beforeAll(async () => {
    world = makeWorld();
    [alice, bob, erin] = (await Promise.all(
      ["alice", "bob", "erin"].map((name) => world.person(name)),
    )) as [Person, Person, Person];
    acme = await world.organization("acme", { paid: true, members: [[erin, "admin"]] });
    beta = await world.organization("beta", { paid: true, members: [[erin, "admin"]] });
    await world.repository(alice, alice.username, "priv", "private");
    await world.repository(bob, bob.username, "open", "public");
  });
  afterAll(() => world?.cleanup());

  it("takes a head only from the base's fork network, and no private head into a public base", async () => {
    const base = `/api/repos/${bob.username}/open`;
    // Alice reads her private repository, but it is no fork of Bob's: its commits stay out.
    const unrelated = await world.call("POST", `${base}/pulls`, {
      as: alice,
      body: { title: "t", base: "main", head: "main", headRepository: `${alice.username}/priv` },
    });
    expect(unrelated.status).toBe(422);
    const compared = await world.call(
      "GET",
      `${base}/compare?base=main&head=main&headRepository=${alice.username}/priv`,
      { as: alice },
    );
    expect(compared.status).toBe(422);

    // A fork made private keeps its commits out of the public parent too.
    const fork = await world.call("POST", `${base}/forks`, {
      as: alice,
      body: { owner: alice.username, name: "open-fork" },
    });
    expect(fork.status).toBe(200);
    const hidden = await world.call("PUT", `/api/repos/${alice.username}/open-fork/visibility`, {
      as: alice,
      body: { visibility: "private" },
    });
    expect(hidden.status).toBe(200);
    const fromPrivateFork = await world.call("POST", `${base}/pulls`, {
      as: alice,
      body: {
        title: "t",
        base: "main",
        head: "main",
        headRepository: `${alice.username}/open-fork`,
      },
    });
    expect(fromPrivateFork.status).toBe(422);
  });

  it("leaves the old organisation's accounts behind when a repository is transferred", async () => {
    await world.repository(erin, acme.slug, "infra", "public");
    const accountId = newId();
    await db.insert(accounts).values({
      id: accountId,
      organizationId: acme.id,
      pluginId: "aws",
      displayName: "Production",
      encryptedCredentials: "x",
      credentialsIv: "x",
    });
    const created = await world.call("POST", `/api/repos/${acme.slug}/infra/terraform/workspaces`, {
      as: erin,
      body: { name: "prod", rootPath: "", accountIds: [accountId] },
    });
    expect(created.status).toBe(200);
    expect(created.body.accounts).toHaveLength(1);

    const moved = await world.call("POST", `/api/repos/${acme.slug}/infra/transfer`, {
      as: erin,
      body: { owner: beta.slug },
    });
    expect(moved.status).toBe(200);
    const workspace = await world.call(
      "GET",
      `/api/repos/${beta.slug}/infra/terraform/workspaces/prod`,
      { as: erin },
    );
    expect(workspace.body.accounts).toEqual([]);
    const grants = await db
      .select()
      .from(gitTerraformWorkspaceAccounts)
      .where(eq(gitTerraformWorkspaceAccounts.accountId, accountId));
    expect(grants).toEqual([]);
  });

  it("lets a token without repo:write read and nothing more, and no token rename its person", async () => {
    const issues = `/api/repos/${alice.username}/priv/issues`;
    expect((await world.call("GET", issues, { as: alice, scopes: ["repo:read"] })).status).toBe(
      200,
    );
    const opened = await world.call("POST", issues, {
      as: alice,
      scopes: ["repo:read"],
      body: { title: "from a read-only token" },
    });
    expect(opened.status).toBe(403);
    const written = await world.call("POST", issues, {
      as: alice,
      scopes: ["repo:read", "repo:write"],
      body: { title: "from a token that writes" },
    });
    expect(written.status).toBe(200);

    const renamed = await world.call("PUT", "/api/session/username", {
      as: alice,
      scopes: ["repo:read", "repo:write"],
      body: { username: `${alice.username}-x` },
    });
    expect(renamed.status).toBe(403);
  });

  it("lends accounts only with ci-access:write, and shows them only to the organisation", async () => {
    const dave = await world.person("dave");
    const gamma = await world.organization("gamma", {
      paid: true,
      members: [
        [erin, "admin"],
        [dave, "member"],
      ],
    });
    await world.repository(erin, gamma.slug, "stack", "public");
    const repo = `/api/repos/${gamma.slug}/stack`;
    const accountId = newId();
    await db.insert(accounts).values({
      id: accountId,
      organizationId: gamma.id,
      pluginId: "aws",
      displayName: "Production",
      encryptedCredentials: "x",
      credentialsIv: "x",
    });
    // Dave administers the repository and sees the organisation's accounts, but may not lend them.
    await world.call("PUT", `${repo}/collaborators/${dave.username}`, {
      as: erin,
      body: { role: "admin" },
    });
    const refused = await world.call("POST", `${repo}/terraform/workspaces`, {
      as: dave,
      body: { name: "prod", rootPath: "", accountIds: [accountId] },
    });
    expect(refused.status).toBe(403);
    const lent = await world.call("POST", `${repo}/terraform/workspaces`, {
      as: erin,
      body: { name: "prod", rootPath: "", accountIds: [accountId] },
    });
    expect(lent.status).toBe(200);
    expect(lent.body.accounts).toHaveLength(1);

    // A reader of the public repository who is not a member sees no accounts.
    const outside = await world.call("GET", `${repo}/terraform/workspaces/prod`, { as: bob });
    expect(outside.status).toBe(200);
    expect(outside.body.accounts).toEqual([]);
    const anonymous = await world.call("GET", `${repo}/terraform/workspaces`);
    expect(anonymous.body.workspaces[0].accounts).toEqual([]);
  });
});
