/**
 * Profiles and commit checks against a real Postgres: who may edit a
 * namespace's bio and an organisation's picture, what a picture must be, and
 * that the commits a page summarises carry their checks from one lookup.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BIO_MAX_LENGTH, type CommitSummary, parseAvatarPath } from "@infrawrench/git-contract";
import { gitCommitStatuses, gitNamespaces } from "@infrawrench/server-core/db/schema";
import { commitDecorator } from "../../api/views/commits";
import { db, newId } from "../../db/client";
import type { AvatarBucket } from "../../images/avatar";
import { serveAvatar } from "../../images/avatar";
import { type Person, type World, configured, makeWorld } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));

const u32 = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const text = (value: string): number[] => [...value].map((char) => char.charCodeAt(0));
const png = (side: number): Uint8Array =>
  new Uint8Array([
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...u32(13),
    ...text("IHDR"),
    ...u32(side),
    ...u32(side),
    ...[8, 2, 0, 0, 0],
    ...u32(0),
    ...u32(0),
    ...text("IDAT"),
    ...u32(0),
  ]);
const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

const memoryBucket = () => {
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async get(key: string) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return {
        size: bytes.length,
        body: new Blob([bytes as Uint8Array<ArrayBuffer>]).stream(),
        arrayBuffer: async () => bytes.buffer,
      };
    },
    async put(key: string, bytes: Uint8Array) {
      objects.set(key, bytes);
      return null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  return { objects, bucket: bucket as unknown as AvatarBucket };
};

describe.skipIf(!configured)("profiles and commit checks, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person, erin: Person, dave: Person;
  let acme: { id: string; slug: string };
  const store = memoryBucket();

  beforeAll(async () => {
    world = makeWorld();
    (world.env as { OBJECTS: unknown }).OBJECTS = store.bucket;
    [alice, bob, erin, dave] = (await Promise.all(
      ["alice", "bob", "erin", "dave"].map((name) => world.person(name)),
    )) as [Person, Person, Person, Person];
    acme = await world.organization("acme", {
      paid: true,
      members: [
        [erin, "admin"],
        [dave, "member"],
      ],
    });
  });
  afterAll(() => world?.cleanup());

  const edit = (slug: string, body: unknown, options: { as?: Person; scopes?: [] } = {}) =>
    world.call("PATCH", `/api/namespaces/${slug}`, { ...options, body });
  const setPicture = (
    slug: string,
    bytes: Uint8Array,
    options: { as?: Person; scopes?: [] } = {},
  ) =>
    world.call("PUT", `/api/namespaces/${slug}/avatar`, {
      ...options,
      body: { image: base64(bytes) },
    });

  describe("a bio", () => {
    it("is the person's own to write, and anyone's to read", async () => {
      const bio = "Platform engineer. Notes at https://example.test/notes <b>plain</b>";
      const saved = await edit(
        alice.username,
        { description: bio, location: "Lund" },
        { as: alice },
      );
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ description: bio, location: "Lund" });
      // Stored and answered as the text it is, to a signed-out reader too.
      const read = await world.call("GET", `/api/namespaces/${alice.username}`);
      expect(read.status).toBe(200);
      expect(read.body.description).toBe(bio);
      expect(read.body.viewer.canAdminister).toBe(false);
    });

    it("is refused past its length, and a website that is not a web address", async () => {
      const long = await edit(
        alice.username,
        { description: "a".repeat(BIO_MAX_LENGTH + 1) },
        { as: alice },
      );
      expect(long.status).toBe(400);
      const fits = await edit(
        alice.username,
        { description: "a".repeat(BIO_MAX_LENGTH) },
        { as: alice },
      );
      expect(fits.status).toBe(200);
      const script = await edit(
        alice.username,
        { websiteUrl: "javascript:alert(1)" },
        { as: alice },
      );
      expect(script.status).toBe(400);
    });

    it("is nobody else's to write: another person, a signed-out caller, a token", async () => {
      expect((await edit(alice.username, { description: "x" }, { as: bob })).status).toBe(403);
      expect((await edit(alice.username, { description: "x" })).status).toBe(401);
      // The person's own token reaches no settings.
      expect(
        (await edit(alice.username, { description: "x" }, { as: alice, scopes: [] })).status,
      ).toBe(403);
      expect((await edit("nobody-here-at-all", { description: "x" }, { as: alice })).status).toBe(
        404,
      );
    });

    it("of an organisation is its administrators' to write", async () => {
      const saved = await edit(
        acme.slug,
        { description: "Acme's platform team", websiteUrl: "https://acme.example" },
        { as: erin },
      );
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({
        description: "Acme's platform team",
        websiteUrl: "https://acme.example",
      });
      // A member without `git:admin`, and someone outside the organisation.
      expect((await edit(acme.slug, { description: "x" }, { as: dave })).status).toBe(403);
      expect((await edit(acme.slug, { description: "x" }, { as: bob })).status).toBe(403);
      const read = await world.call("GET", `/api/namespaces/${acme.slug}`, { as: dave });
      expect(read.body.description).toBe("Acme's platform team");
      expect(read.body.viewer.canAdminister).toBe(false);
    });
  });

  describe("an organisation's picture", () => {
    it("is uploaded by an administrator, stored, and served from this site", async () => {
      const set = await setPicture(acme.slug, png(256), { as: erin });
      expect(set.status).toBe(200);
      const parsed = parseAvatarPath(set.body.avatarUrl);
      expect(parsed).not.toBeNull();
      expect(parsed!.name).toMatch(/\.png$/);
      expect([...store.objects.keys()]).toEqual([`avatars/${parsed!.namespaceId}/${parsed!.name}`]);
      const [row] = await db
        .select({ id: gitNamespaces.id, avatarUrl: gitNamespaces.avatarUrl })
        .from(gitNamespaces)
        .where(eq(gitNamespaces.organizationId, acme.id));
      expect(row).toEqual({ id: parsed!.namespaceId, avatarUrl: set.body.avatarUrl });

      // Anyone sees it on the namespace, and reads the file with no session.
      const read = await world.call("GET", `/api/namespaces/${acme.slug}`);
      expect(read.body.avatarUrl).toBe(set.body.avatarUrl);
      const served = await serveAvatar(
        new Request(`https://git.example.test${set.body.avatarUrl}`),
        store.bucket,
      );
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("image/png");
    });

    it("replaces the one before it, and is removed back to none", async () => {
      const second = await setPicture(acme.slug, png(128), { as: erin });
      expect(second.status).toBe(200);
      const parsed = parseAvatarPath(second.body.avatarUrl)!;
      expect([...store.objects.keys()]).toEqual([`avatars/${parsed.namespaceId}/${parsed.name}`]);

      const removed = await world.call("DELETE", `/api/namespaces/${acme.slug}/avatar`, {
        as: erin,
      });
      expect(removed.status).toBe(200);
      expect(removed.body.avatarUrl).toBeNull();
      expect(store.objects.size).toBe(0);
      // Removing nothing is still an answer.
      expect(
        (await world.call("DELETE", `/api/namespaces/${acme.slug}/avatar`, { as: erin })).status,
      ).toBe(200);
    });

    it("is refused from everyone else, and nothing is stored", async () => {
      expect((await setPicture(acme.slug, png(64), { as: dave })).status).toBe(403);
      expect((await setPicture(acme.slug, png(64), { as: bob })).status).toBe(403);
      expect((await setPicture(acme.slug, png(64))).status).toBe(401);
      expect((await setPicture(acme.slug, png(64), { as: erin, scopes: [] })).status).toBe(403);
      expect(
        (await world.call("DELETE", `/api/namespaces/${acme.slug}/avatar`, { as: dave })).status,
      ).toBe(403);
      expect(store.objects.size).toBe(0);
    });

    it("is not a person's to upload: theirs is their account's", async () => {
      const own = await setPicture(alice.username, png(64), { as: alice });
      expect(own.status).toBe(400);
      expect(own.body.error).toMatch(/Infrawrench account/);
      expect((await setPicture(alice.username, png(64), { as: bob })).status).toBe(403);
      expect(store.objects.size).toBe(0);
    });

    it("must be a still PNG, JPEG or WebP within the limits, whatever it claims", async () => {
      const page = new TextEncoder().encode(
        "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>",
      );
      for (const bytes of [page, png(8), png(4096)]) {
        const refused = await setPicture(acme.slug, bytes, { as: erin });
        expect(refused.status).toBe(400);
      }
      const notBase64 = await world.call("PUT", `/api/namespaces/${acme.slug}/avatar`, {
        as: erin,
        body: { image: "data:image/png;base64,AAAA" },
      });
      expect(notBase64.status).toBe(400);
      expect(store.objects.size).toBe(0);
      const [row] = await db
        .select({ avatarUrl: gitNamespaces.avatarUrl })
        .from(gitNamespaces)
        .where(eq(gitNamespaces.organizationId, acme.id));
      expect(row?.avatarUrl).toBeNull();
    });
  });

  describe("a commit's checks", () => {
    const commit = (oid: string): CommitSummary => ({
      oid,
      summary: "A change",
      hasBody: false,
      author: {
        name: "Alice",
        email: alice.email,
        when: "2026-11-01T10:00:00.000Z",
        timezoneOffset: 0,
      },
      committer: {
        name: "Alice",
        email: alice.email,
        when: "2026-11-01T10:00:00.000Z",
        timezoneOffset: 0,
      },
      authorUser: null,
      coAuthors: [],
      parents: [],
      status: null,
    });
    const passed = "a".repeat(40);
    const failed = "b".repeat(40);
    const none = "c".repeat(40);
    let repository: { id: string; path: string };

    beforeAll(async () => {
      repository = await world.repository(alice, alice.username, "checks", "private");
      const status = (
        sha: string,
        context: string,
        state: "success" | "failure" | "pending",
        ciRunId: string | null,
      ) => ({
        id: newId(),
        repositoryId: repository.id,
        sha,
        context,
        state,
        description: state,
        targetUrl: "https://app.example.test/org/o/ci/run-1",
        ciRunId,
      });
      await db
        .insert(gitCommitStatuses)
        .values([
          status(passed, "Infrawrench CI / push", "success", "run-1"),
          status(passed, "ci / test (push)", "success", "run-1"),
          status(failed, "Infrawrench CI / push", "failure", "run-2"),
          status(failed, "ci / test (push)", "pending", "run-2"),
          status(failed, "external / deploy", "success", null),
        ]);
    });

    it("come with every commit of a page, combined, and null where there are none", async () => {
      const decorate = await commitDecorator(repository.id, [
        commit(passed),
        commit(failed),
        commit(none),
      ]);
      expect(decorate(commit(passed)).status).toBe("success");
      expect(decorate(commit(failed)).status).toBe("failure");
      expect(decorate(commit(none)).status).toBeNull();
    });

    it("come only for the commits a listing names, and for none when it asks for none", async () => {
      const commits = [commit(passed), commit(failed)];
      const header = await commitDecorator(repository.id, commits, { statuses: [passed] });
      expect(header(commit(passed)).status).toBe("success");
      expect(header(commit(failed)).status).toBeNull();
      const without = await commitDecorator(repository.id, commits, { statuses: false });
      expect(without(commit(passed)).status).toBeNull();
    });

    it("are listed for one commit, each with the run that reported it", async () => {
      const list = await world.call("GET", `${repository.path}/statuses?ref=${failed}`, {
        as: alice,
      });
      expect(list.status).toBe(200);
      expect(list.body.state).toBe("failure");
      // In the database's order of names, which is not this test's business.
      const listed = (
        list.body.statuses as Array<{ context: string; state: string; runId: string | null }>
      )
        .map((status) => [status.context, status.state, status.runId])
        .sort((x, y) => (x[0]! < y[0]! ? -1 : 1));
      expect(listed).toEqual([
        ["Infrawrench CI / push", "failure", "run-2"],
        ["ci / test (push)", "pending", "run-2"],
        ["external / deploy", "success", null],
      ]);
    });

    it("of a private repository are missing for anyone who cannot read it", async () => {
      const missing = await world.call(
        "GET",
        `/api/repos/${alice.username}/no-such/statuses?ref=${failed}`,
        { as: bob },
      );
      const hidden = await world.call("GET", `${repository.path}/statuses?ref=${failed}`, {
        as: bob,
      });
      expect(hidden.status).toBe(404);
      expect(hidden).toEqual(missing);
      // And signed out, the same again.
      expect(await world.call("GET", `${repository.path}/statuses?ref=${failed}`)).toEqual(
        await world.call("GET", `/api/repos/${alice.username}/no-such/statuses?ref=${failed}`),
      );
    });
  });
});
