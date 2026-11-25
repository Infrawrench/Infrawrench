/**
 * Who sees what, against a real Postgres: a private repository the caller
 * cannot read is in no list and reads as a 404, whichever way it is asked
 * for; and the records around a repository (namespaces, forks, stars,
 * archive, delete) follow the same answer.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Person, type World, configured, makeWorld } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));

describe.skipIf(!configured)("visibility, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person, carol: Person, dave: Person, erin: Person;
  let acme: { id: string; slug: string };
  const names = (answer: { body: { items: Array<{ name: string }> } }) =>
    answer.body.items.map((item) => item.name).sort();

  beforeAll(async () => {
    world = makeWorld();
    [alice, bob, carol, dave, erin] = (await Promise.all(
      ["alice", "bob", "carol", "dave", "erin"].map((name) => world.person(name)),
    )) as [Person, Person, Person, Person, Person];
    acme = await world.organization("acme", {
      paid: true,
      members: [
        [erin, "admin"],
        [dave, "member"],
      ],
    });
    await world.repository(alice, alice.username, "pub", "public");
    await world.repository(alice, alice.username, "priv", "private");
    await world.repository(erin, acme.slug, "secret", "private");
    await world.repository(erin, acme.slug, "open", "public");
  });
  afterAll(() => world?.cleanup());

  it("answers a private repository 404 to a stranger, exactly as one that is not there", async () => {
    const hidden = await world.call("GET", `/api/repos/${alice.username}/priv`, { as: bob });
    const missing = await world.call("GET", `/api/repos/${alice.username}/nothing`, { as: bob });
    expect(hidden).toEqual({ status: 404, body: { error: "Repository not found" } });
    expect(missing).toEqual(hidden);
    expect((await world.call("GET", `/api/repos/${alice.username}/priv`)).status).toBe(404);
    // Under it too: nothing about the repository answers.
    for (const path of ["/issues", "/labels", "/collaborators", "/statuses", "/ci/runs"]) {
      const answer = await world.call("GET", `/api/repos/${alice.username}/priv${path}`, {
        as: bob,
      });
      expect(answer.status, path).toBe(404);
    }
    expect(
      (await world.call("GET", `/api/repos/${alice.username}/priv`, { as: alice })).status,
    ).toBe(200);
  });

  it("lists a namespace's repositories as far as the caller can read them", async () => {
    const path = `/api/namespaces/${alice.username}/repos`;
    expect(names(await world.call("GET", path))).toEqual(["pub"]);
    expect(names(await world.call("GET", path, { as: bob }))).toEqual(["pub"]);
    expect(names(await world.call("GET", path, { as: alice }))).toEqual(["priv", "pub"]);
    expect(names(await world.call("GET", `${path}?type=private`, { as: bob }))).toEqual([]);
    // The count on the profile is of what the viewer can see, too.
    const profile = (who?: Person) =>
      world.call("GET", `/api/namespaces/${alice.username}`, { as: who });
    expect((await profile(bob)).body.repositoryCount).toBe(1);
    expect((await profile(alice)).body.repositoryCount).toBe(2);
  });

  it("gives an organisation's members its private repositories and nobody else", async () => {
    const path = `/api/namespaces/${acme.slug}/repos`;
    expect(names(await world.call("GET", path, { as: dave }))).toEqual(["open", "secret"]);
    expect(names(await world.call("GET", path, { as: bob }))).toEqual(["open"]);
    expect((await world.call("GET", `/api/repos/${acme.slug}/secret`, { as: dave })).status).toBe(
      200,
    );
    expect((await world.call("GET", `/api/repos/${acme.slug}/secret`, { as: bob })).status).toBe(
      404,
    );
    // The organisation's id and its link to the app are its members' to see.
    const seenBy = async (who: Person) =>
      (await world.call("GET", `/api/namespaces/${acme.slug}`, { as: who })).body;
    expect((await seenBy(dave)).organizationId).toBe(acme.id);
    expect((await seenBy(bob)).organizationId).toBeNull();
    expect((await seenBy(bob)).appUrl).toBeNull();
  });

  it("keeps private repositories out of explore and search", async () => {
    const search = (who?: Person) =>
      world.call("GET", `/api/explore/repos?q=${world.suffix}&limit=100`, { as: who });
    const q = (who?: Person) =>
      world.call("GET", `/api/explore/repos?limit=100&sort=created`, { as: who });
    const mine = (answer: Awaited<ReturnType<typeof q>>) =>
      answer.body.items
        .filter((item: { owner: { slug: string } }) => item.owner.slug.endsWith(world.suffix))
        .map((item: { name: string }) => item.name)
        .sort();
    expect(mine(await q())).toEqual(["open", "pub"]);
    expect(mine(await q(bob))).toEqual(["open", "pub"]);
    expect(mine(await q(dave))).toEqual(["open", "pub", "secret"]);
    expect(mine(await q(alice))).toEqual(["open", "priv", "pub"]);
    expect((await search()).status).toBe(200);
    // Searching for a private repository by its exact name finds nothing.
    const byName = await world.call("GET", "/api/explore/repos?q=secret&limit=100", { as: bob });
    expect(mine(byName)).toEqual([]);
  });

  it("opens a private repository to a collaborator, at their role and no further", async () => {
    const repo = `/api/repos/${alice.username}/priv`;
    const added = await world.call("PUT", `${repo}/collaborators/${carol.username}`, {
      as: alice,
      body: { role: "read" },
    });
    expect(added.status).toBe(200);
    const seen = await world.call("GET", repo, { as: carol });
    expect(seen.status).toBe(200);
    expect(seen.body.viewer).toMatchObject({
      access: "read",
      canPush: false,
      canAdminister: false,
    });
    // Settings stay closed to them, and say so rather than hiding: they can see the repository.
    expect((await world.call("GET", `${repo}/collaborators`, { as: carol })).status).toBe(403);

    const reach = (access: string) =>
      world.call("GET", `/api/user/repos?access=${access}`, { as: carol });
    expect(names(await reach("read"))).toEqual(["priv"]);
    expect(names(await reach("write"))).toEqual([]);
    await world.call("PUT", `${repo}/collaborators/${carol.username}`, {
      as: alice,
      body: { role: "write" },
    });
    expect(names(await reach("write"))).toEqual(["priv"]);

    await world.call("DELETE", `${repo}/collaborators/${carol.username}`, { as: alice });
    expect((await world.call("GET", repo, { as: carol })).status).toBe(404);
  });

  it("caps a personal access token by its scopes", async () => {
    const repo = `/api/repos/${alice.username}/priv`;
    expect((await world.call("GET", repo, { as: alice, scopes: ["repo:read"] })).status).toBe(200);
    // No repository scope: a signed-out visitor, as far as repositories go.
    expect((await world.call("GET", repo, { as: alice, scopes: [] })).status).toBe(404);
    const mine = await world.call("GET", "/api/user/repos", { as: alice, scopes: [] });
    expect(names(mine)).toEqual([]);
    // A token never reaches settings, whatever its scopes.
    const settings = await world.call("GET", `${repo}/collaborators`, {
      as: alice,
      scopes: ["repo:read", "repo:write"],
    });
    expect(settings.status).toBe(403);
    expect(
      (await world.call("GET", "/api/user/tokens", { as: alice, scopes: ["repo:write"] })).status,
    ).toBe(403);
  });

  it("shows stars and forks only where the repository shows", async () => {
    await world.call("PUT", `/api/repos/${alice.username}/priv/star`, { as: alice });
    await world.call("PUT", `/api/repos/${alice.username}/pub/star`, { as: alice });
    await world.call("PUT", `/api/repos/${alice.username}/pub/star`, { as: alice });
    const starred = (who: Person) =>
      world.call("GET", `/api/namespaces/${alice.username}/starred`, { as: who });
    expect(names(await starred(alice))).toEqual(["priv", "pub"]);
    expect(names(await starred(bob))).toEqual(["pub"]);
    // Starring twice is one star.
    expect((await world.call("GET", `/api/repos/${alice.username}/pub`)).body.starCount).toBe(1);
    expect(
      (await world.call("PUT", `/api/repos/${alice.username}/priv/star`, { as: bob })).status,
    ).toBe(404);

    const fork = await world.call("POST", `/api/repos/${alice.username}/pub/forks`, {
      as: bob,
      body: { owner: bob.username },
    });
    expect(fork.status).toBe(200);
    expect(fork.body).toMatchObject({ isFork: true, visibility: "public", isEmpty: false });
    expect(fork.body.parent).toMatchObject({ owner: alice.username, name: "pub" });
    expect(world.storage.repository(fork.body.id).branches.has("main")).toBe(true);
    expect(names(await world.call("GET", `/api/repos/${alice.username}/pub/forks`))).toEqual([
      "pub",
    ]);
    expect((await world.call("GET", `/api/repos/${alice.username}/pub`)).body.forkCount).toBe(1);

    // A private repository's fork stays private, inside the same owner's reach.
    const away = await world.call("POST", `/api/repos/${acme.slug}/secret/forks`, {
      as: dave,
      body: { owner: dave.username },
    });
    expect(away.status).toBe(422);
    const within = await world.call("POST", `/api/repos/${acme.slug}/secret/forks`, {
      as: dave,
      body: { owner: acme.slug, name: "secret-fork" },
    });
    expect(within.body).toMatchObject({ visibility: "private", isFork: true });
    const published = await world.call("PUT", `/api/repos/${acme.slug}/secret-fork/visibility`, {
      as: erin,
      body: { visibility: "public" },
    });
    expect(published.status).toBe(422);
  });

  it("creates repositories only where the caller may, under the name rules and the plan", async () => {
    const create = (who: Person, body: Record<string, unknown>) =>
      world.call("POST", "/api/repos", { as: who, body: { visibility: "public", ...body } });
    expect((await create(bob, { owner: alice.username, name: "x" })).status).toBe(403);
    expect((await create(bob, { owner: acme.slug, name: "x" })).status).toBe(403);
    expect((await create(dave, { owner: acme.slug, name: "by-dave" })).status).toBe(200);
    expect(await create(alice, { owner: alice.username, name: "settings" })).toMatchObject({
      status: 400,
      body: { code: "name_invalid" },
    });
    expect(await create(alice, { owner: alice.username, name: "bad.git" })).toMatchObject({
      status: 400,
      body: { code: "name_invalid" },
    });
    expect(await create(alice, { owner: alice.username, name: "PUB" })).toMatchObject({
      status: 409,
      body: { code: "name_taken" },
    });

    const free = await world.organization("free", { members: [[erin, "owner"]] });
    expect(
      await create(erin, { owner: free.slug, name: "hidden", visibility: "private" }),
    ).toMatchObject({ status: 402, body: { code: "plan_required" } });
    expect((await create(erin, { owner: free.slug, name: "shown" })).status).toBe(200);
  });

  it("lets only git:admin claim an organisation's namespace, once", async () => {
    const unclaimed = await world.organization("fresh", {
      members: [
        [erin, "admin"],
        [dave, "member"],
      ],
      namespace: false,
    });
    const claim = (who: Person | undefined, slug: string) =>
      world.call("POST", `/api/orgs/${unclaimed.id}/namespace`, { as: who, body: { slug } });
    expect((await claim(undefined, unclaimed.slug)).status).toBe(401);
    expect((await claim(bob, unclaimed.slug)).status).toBe(403);
    expect((await claim(dave, unclaimed.slug)).status).toBe(403);
    expect(await claim(erin, "explore")).toMatchObject({ status: 400 });
    expect(await claim(erin, alice.username)).toMatchObject({
      status: 409,
      body: { code: "namespace_taken" },
    });
    const claimed = await claim(erin, unclaimed.slug);
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({ slug: unclaimed.slug, kind: "org" });
    expect(claimed.body.viewer).toMatchObject({ isOwner: true, canCreateRepository: true });
    expect(await claim(erin, `${unclaimed.slug}-2`)).toMatchObject({
      status: 409,
      body: { code: "namespace_already_claimed" },
    });
    // The session says so too.
    const me = await world.call("GET", "/api/session", { as: erin });
    const entry = me.body.organizations.find((o: { id: string }) => o.id === unclaimed.id);
    expect(entry).toMatchObject({ namespace: unclaimed.slug, canClaimNamespace: false });
  });

  it("holds writes until a signed-in person has a username", async () => {
    const newcomer = await world.person("frank", { username: false });
    const me = await world.call("GET", "/api/session", { as: newcomer });
    expect(me.body.user.username).toBeNull();
    expect(me.body.onboarding).toMatchObject({ needsUsername: true });
    expect(typeof me.body.onboarding.suggestedUsername).toBe("string");
    // Reads like a visitor.
    expect(
      (await world.call("GET", `/api/repos/${alice.username}/pub`, { as: newcomer })).status,
    ).toBe(200);
    expect(
      await world.call("PUT", `/api/repos/${alice.username}/pub/star`, { as: newcomer }),
    ).toMatchObject({ status: 403, body: { code: "username_required" } });

    const claim = (username: string) =>
      world.call("POST", "/api/session/username", { as: newcomer, body: { username } });
    expect(await claim("api")).toMatchObject({ status: 400, body: { code: "username_reserved" } });
    expect(await claim("-nope")).toMatchObject({ status: 400, body: { code: "username_invalid" } });
    expect(await claim(alice.username.toUpperCase())).toMatchObject({
      status: 409,
      body: { code: "username_taken" },
    });
    expect((await claim(newcomer.username)).status).toBe(200);
    expect(await claim(`${newcomer.username}-2`)).toMatchObject({
      status: 409,
      body: { code: "namespace_already_claimed" },
    });
    expect(
      (await world.call("PUT", `/api/repos/${alice.username}/pub/star`, { as: newcomer })).status,
    ).toBe(200);
  });

  it("makes an archived repository read-only for everyone but leaves its settings to its admins", async () => {
    const repo = (await world.repository(alice, alice.username, "old")).path;
    const archived = await world.call("PATCH", repo, { as: alice, body: { archived: true } });
    expect(archived.body.viewer).toMatchObject({ access: "read", canAdminister: true });
    expect(
      await world.call("POST", `${repo}/issues`, { as: alice, body: { title: "Late" } }),
    ).toMatchObject({ status: 403, body: { code: "repository_archived" } });
    expect(
      await world.call("POST", `${repo}/labels`, {
        as: alice,
        body: { name: "x", color: "ffffff" },
      }),
    ).toMatchObject({ status: 403, body: { code: "repository_archived" } });
    expect((await world.call("GET", `${repo}/collaborators`, { as: alice })).status).toBe(200);
    expect((await world.call("PUT", `${repo}/star`, { as: bob })).status).toBe(200);
    const restored = await world.call("PATCH", repo, { as: alice, body: { archived: false } });
    expect(restored.body.viewer.access).toBe("admin");
  });

  it("deletes a repository's record and then its storage, and only when confirmed", async () => {
    const made = await world.repository(alice, alice.username, "gone");
    expect((await world.call("DELETE", `${made.path}?confirm=gone`, { as: alice })).status).toBe(
      400,
    );
    expect(
      (await world.call("DELETE", `${made.path}?confirm=${alice.username}/gone`, { as: bob }))
        .status,
    ).toBe(403);
    const deleted = await world.call("DELETE", `${made.path}?confirm=${alice.username}/gone`, {
      as: alice,
    });
    expect(deleted).toEqual({ status: 200, body: { ok: true } });
    expect((await world.call("GET", made.path, { as: alice })).status).toBe(404);
    expect(world.storage.repository(made.id).destroyed).toBe(true);
  });

  it("renames and transfers without moving anything", async () => {
    const made = await world.repository(alice, alice.username, "before");
    const renamed = await world.call("POST", `${made.path}/rename`, {
      as: alice,
      body: { name: "after" },
    });
    expect(renamed.body).toMatchObject({ id: made.id, name: "after" });
    expect((await world.call("GET", made.path)).status).toBe(404);
    const taken = await world.call("POST", `/api/repos/${alice.username}/after/rename`, {
      as: alice,
      body: { name: "pub" },
    });
    expect(taken).toMatchObject({ status: 409, body: { code: "name_taken" } });
    // Into an organisation needs git:admin there.
    const refused = await world.call("POST", `/api/repos/${alice.username}/after/transfer`, {
      as: alice,
      body: { owner: acme.slug },
    });
    expect(refused.status).toBe(403);
  });
});
