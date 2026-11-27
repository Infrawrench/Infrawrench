/**
 * What the forms ask before they submit, against a real Postgres: whether a
 * repository name is free (told to nobody its creation would not tell), what
 * a new repository starts as and whether a private one still fits the plan
 * (the session), and a repository's own CI switch.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FORGE_LIMITS } from "@infrawrench/git-contract";
import { ciGitRepositories, gitNamespaces } from "@infrawrench/server-core/db/schema";
import { db } from "../../db/client";
import { type Person, type World, configured, makeWorld } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));

describe.skipIf(!configured)("what the forms ask, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person, dave: Person, erin: Person, frank: Person;
  let acme: { id: string; slug: string };
  let small: { id: string; slug: string };

  beforeAll(async () => {
    world = makeWorld();
    [alice, bob, dave, erin, frank] = (await Promise.all(
      ["alice", "bob", "dave", "erin", "frank"].map((name) => world.person(name)),
    )) as [Person, Person, Person, Person, Person];
    acme = await world.organization("acme", {
      paid: true,
      members: [
        [erin, "admin"],
        [dave, "member"],
      ],
    });
    small = await world.organization("small", { members: [[frank, "owner"]] });
    await world.repository(alice, alice.username, "pub", "public");
    await world.repository(alice, alice.username, "priv", "private");
    await world.repository(erin, acme.slug, "secret", "private");
    await world.repository(erin, acme.slug, "open", "public");
  });
  afterAll(() => world?.cleanup());

  const availability = (namespace: string, name: string, as?: Person) =>
    world.call(
      "GET",
      `/api/namespaces/${namespace}/repository-name-availability?name=${encodeURIComponent(name)}`,
      { as },
    );

  describe("a new repository's name", () => {
    it("is free, taken or invalid for someone who may create there", async () => {
      expect((await availability(alice.username, "fresh", alice)).body).toEqual({
        name: "fresh",
        available: true,
        reason: null,
        message: null,
      });
      const taken = await availability(alice.username, "PRIV", alice);
      expect(taken.status).toBe(200);
      expect(taken.body).toMatchObject({ available: false, reason: "taken" });
      const invalid = await availability(alice.username, "-nope", alice);
      expect(invalid.body).toMatchObject({ available: false, reason: "invalid" });
      expect(invalid.body.message).toEqual(expect.any(String));
      // An organisation's member with `git:write` is told of its private repository, which they can read.
      expect((await availability(acme.slug, "secret", erin)).body.reason).toBe("taken");
    });

    it("answers a stranger the same whether the name is a private repository's or nobody's", async () => {
      const hidden = await availability(alice.username, "priv", bob);
      const free = await availability(alice.username, "nothing-here", bob);
      expect(hidden.status).toBe(403);
      expect(free).toEqual(hidden);
      const inOrganization = await availability(acme.slug, "secret", bob);
      expect(inOrganization.status).toBe(403);
      expect(await availability(acme.slug, "nothing-here", bob)).toEqual(inOrganization);
      // And it refuses exactly as creating there does.
      const create = await world.call("POST", "/api/repos", {
        as: bob,
        body: { owner: alice.username, name: "priv", visibility: "public" },
      });
      expect(create.status).toBe(403);
      expect(hidden.body).toEqual(create.body);
    });

    it("needs someone signed in, and a token that may write", async () => {
      expect((await availability(alice.username, "priv")).status).toBe(401);
      const readOnly = await world.call(
        "GET",
        `/api/namespaces/${alice.username}/repository-name-availability?name=priv`,
        { as: alice, scopes: ["repo:read"] },
      );
      expect(readOnly.status).toBe(403);
    });

    it("answers 404 for a namespace that is not there", async () => {
      expect((await availability(`nobody-${world.suffix}`, "x", alice)).status).toBe(404);
    });
  });

  describe("a rename", () => {
    const rename = (name: string, as?: Person) =>
      world.call(
        "GET",
        `/api/repos/${alice.username}/pub/rename-availability?name=${encodeURIComponent(name)}`,
        { as },
      );

    it("may keep its own name in another case, and not take a sibling's", async () => {
      expect((await rename("Pub", alice)).body).toMatchObject({ available: true });
      expect((await rename("priv", alice)).body).toMatchObject({
        available: false,
        reason: "taken",
      });
      expect((await rename("renamed", alice)).body).toMatchObject({ available: true });
      expect((await rename("a b", alice)).body).toMatchObject({ reason: "invalid" });
    });

    it("is only answered to the repository's administrators", async () => {
      expect((await rename("priv", bob)).status).toBe(403);
      expect((await rename("priv")).status).toBe(401);
      // A private repository answers a stranger 404 here as everywhere.
      const hidden = await world.call(
        "GET",
        `/api/repos/${alice.username}/priv/rename-availability?name=pub`,
        { as: bob },
      );
      expect(hidden.status).toBe(404);
    });
  });

  describe("the session", () => {
    it("carries each namespace's default visibility", async () => {
      await db
        .update(gitNamespaces)
        .set({ defaultVisibility: "public" })
        .where(eq(gitNamespaces.organizationId, acme.id));
      const session = await world.call("GET", "/api/session", { as: erin });
      const organization = session.body.organizations.find(
        (item: { id: string }) => item.id === acme.id,
      );
      expect(organization).toMatchObject({
        defaultVisibility: "public",
        privateRepositories: true,
        privateRepositoryRefusal: null,
      });
      expect(session.body.personal).toEqual({
        privateRepositories: true,
        privateRepositoryRefusal: null,
        defaultVisibility: "private",
        workspace: null,
      });
    });

    it("says why a private repository no longer fits, in the quota's words", async () => {
      const limit = FORGE_LIMITS.free.privateRepositories!;
      for (let index = 0; index < limit; index += 1) {
        await world.repository(frank, small.slug, `private-${index}`, "private");
      }
      const session = await world.call("GET", "/api/session", { as: frank });
      const organization = session.body.organizations.find(
        (item: { id: string }) => item.id === small.id,
      );
      expect(organization.privateRepositories).toBe(false);
      expect(organization.privateRepositoryRefusal).toContain(`${limit} private repositories`);
      // It is the sentence creating one is refused with.
      const refused = await world.call("POST", "/api/repos", {
        as: frank,
        body: { owner: small.slug, name: "one-more", visibility: "private" },
      });
      expect(refused.status).toBe(402);
      expect(refused.body).toEqual({
        error: organization.privateRepositoryRefusal,
        code: "plan_required",
      });
    });

    it("has nothing personal for a signed-out browser", async () => {
      expect((await world.call("GET", "/api/session")).body.personal).toBeNull();
    });
  });

  describe("a repository's CI switch", () => {
    const path = () => `/api/repos/${acme.slug}/open/ci/settings`;

    it("is on until an administrator turns it off", async () => {
      // Where its secrets, variables and approvals are: CI in the app, for the organisation.
      const appUrl = `https://app.example.test/org/${acme.id}/ci`;
      expect((await world.call("GET", path(), { as: erin })).body).toEqual({
        enabled: true,
        available: true,
        appUrl,
      });
      const off = await world.call("PUT", path(), { as: erin, body: { enabled: false } });
      expect(off).toEqual({ status: 200, body: { enabled: false, available: true, appUrl } });
      expect((await world.call("GET", path(), { as: erin })).body.enabled).toBe(false);
      const [row] = await db
        .select()
        .from(ciGitRepositories)
        .where(eq(ciGitRepositories.organizationId, acme.id));
      expect(row).toMatchObject({
        namespace: acme.slug,
        name: "open",
        ciEnabled: false,
        changedByUserId: erin.id,
      });
      // The CI tab says so too.
      const status = await world.call("GET", `/api/repos/${acme.slug}/open/ci`, { as: erin });
      expect(status.body).toMatchObject({ enabled: false });
      expect(status.body.reason).toMatch(/switched off/);
      const on = await world.call("PUT", path(), { as: erin, body: { enabled: true } });
      expect(on.body.enabled).toBe(true);
    });

    it("is not a member's or a stranger's to read or change", async () => {
      for (const who of [dave, bob]) {
        expect((await world.call("GET", path(), { as: who })).status).toBe(403);
        const put = await world.call("PUT", path(), { as: who, body: { enabled: false } });
        expect(put.status).toBe(403);
      }
      expect((await world.call("PUT", path(), { body: { enabled: false } })).status).toBe(401);
      expect((await world.call("GET", path(), { as: erin })).body.enabled).toBe(true);
    });

    it("has nothing to switch in a personal namespace that is connected to no organisation", async () => {
      const personal = `/api/repos/${alice.username}/pub/ci/settings`;
      expect((await world.call("GET", personal, { as: alice })).body).toEqual({
        enabled: true,
        available: false,
        appUrl: null,
      });
      const put = await world.call("PUT", personal, { as: alice, body: { enabled: false } });
      expect(put.status).toBe(422);
      expect(put.body.code).toBe("ci_unavailable");
    });
  });
});
