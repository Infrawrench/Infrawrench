/**
 * Push mirrors against a real Postgres: the settings API (who may, which
 * addresses, the credential that never comes back), what a push event asks
 * for, and the job with its lease, its ordering and its retries. The job
 * pushes for real: the repository is the storage code on its Node
 * stand-ins, filled by `git`, and the target is a bare repository behind
 * `git http-backend`.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { gitPushMirrors } from "@infrawrench/server-core/db/schema";
import { type HttpBackend, startHttpBackend } from "../../../../protocol/test/http-backend";
import {
  cleanupTempDirs,
  commitFile,
  git,
  gitOut,
  hasGit,
  initRepo,
  tempDir,
} from "../../../test/support/git";
import { type NodeRepo, startNodeRepo } from "../../../test/support/node-server";
import { db } from "../../db/client";
import { handleGitEvent } from "../../events/consumer";
import { sweepJobs } from "../../jobs/sweep";
import { type MirrorJobDeps, runMirrorJob } from "../../mirror/job";
import { mirrorsDue } from "../../mirror/store";
import { type Person, type World, configured, makeWorld } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));

process.env["ENCRYPTION_MASTER_KEY"] ??= Buffer.alloc(32, 7).toString("base64");

const hasBackend = hasGit && spawnSync("git", ["http-backend"], { input: "" }).error === undefined;
const USER = "x-access-token";
const CREDENTIAL = "mirror-db-test-credential-not-a-real-one";
const PUBLIC_URL = "https://mirror.example.com/acme/mirror.git";

describe.skipIf(!configured || !hasBackend)("push mirrors, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person;
  let repo: string;
  let id: string;
  let node: NodeRepo;
  let work: string;
  let backend: HttpBackend;
  let bare: string;

  const deps = (): Partial<MirrorJobDeps> => ({
    source: () => node.repository,
    fetch: (url, init) => fetch(url, init),
    allowLocal: true,
  });
  const rowOf = async (mirrorId: string) =>
    (await db.select().from(gitPushMirrors).where(eq(gitPushMirrors.id, mirrorId)))[0]!;
  const targetRefs = async (): Promise<Record<string, string>> =>
    Object.fromEntries(
      (await gitOut(["for-each-ref", "--format=%(refname) %(objectname)"], { cwd: bare }))
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ") as [string, string]),
    );
  const pushEvent = () =>
    handleGitEvent(
      { type: "push", repoId: id, actor: null, updates: [], at: Date.now() },
      world.env,
      world.storage.readers,
    );
  /** A mirror made through the API, then pointed at the Git host on this machine. */
  const addMirror = async (body: Record<string, unknown> = {}): Promise<string> => {
    const made = await world.call("POST", `${repo}/mirrors`, {
      as: alice,
      body: { url: PUBLIC_URL, credential: CREDENTIAL, ...body },
    });
    expect(made.status).toBe(200);
    await db
      .update(gitPushMirrors)
      .set({ url: `${backend.origin}/mirror.git` })
      .where(eq(gitPushMirrors.id, made.body.id));
    return made.body.id as string;
  };

  beforeAll(async () => {
    world = makeWorld();
    [alice, bob] = (await Promise.all(["alice", "bob"].map((name) => world.person(name)))) as [
      Person,
      Person,
    ];
    const made = await world.repository(alice, alice.username, "mirrored");
    repo = made.path;
    id = made.id;
    await world.call("PUT", `${repo}/collaborators/${bob.username}`, {
      as: alice,
      body: { role: "write" },
    });

    node = await startNodeRepo(id);
    work = await initRepo("mirror-db-work");
    for (let i = 0; i < 3; i++) await commitFile(work, `file-${i}.txt`, `${i}\n`, `c${i}`);
    await git(["tag", "-a", "-m", "release", "v1", "HEAD"], { cwd: work });
    await git(["remote", "add", "origin", node.url], { cwd: work });
    await git(["push", "-q", "origin", "main", "v1"], { cwd: work });

    const root = tempDir("mirror-db-target");
    bare = join(root, "mirror.git");
    await git(["init", "-q", "--bare", bare]);
    backend = await startHttpBackend({ root, username: USER, password: CREDENTIAL });
  });
  afterAll(async () => {
    await backend?.close();
    await node?.close();
    await world?.cleanup();
    cleanupTempDirs();
  });
  afterEach(async () => {
    backend.behave({ beforePush: null, status: null });
    await db.delete(gitPushMirrors).where(eq(gitPushMirrors.repositoryId, id));
  });

  it("is an administrator's, in a browser, and takes only a public HTTPS address", async () => {
    const body = { url: PUBLIC_URL, credential: CREDENTIAL };
    expect((await world.call("POST", `${repo}/mirrors`, { body })).status).toBe(401);
    expect((await world.call("POST", `${repo}/mirrors`, { as: bob, body })).status).toBe(403);
    expect((await world.call("GET", `${repo}/mirrors`, { as: bob })).status).toBe(403);
    // A token never administers, its owner's included.
    expect(
      (await world.call("POST", `${repo}/mirrors`, { as: alice, scopes: ["repo:write"], body }))
        .status,
    ).toBe(403);

    for (const url of [
      "http://mirror.example.com/acme/mirror.git",
      `https://${USER}:${CREDENTIAL}@mirror.example.com/acme/mirror.git`,
      "https://127.0.0.1/acme/mirror.git",
      "https://10.1.2.3/acme/mirror.git",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/acme/mirror.git",
      "https://localhost/acme/mirror.git",
      "https://git.internal/acme/mirror.git",
      "https://git.example.test/acme/mirror.git",
      "https://mirror.example.com/",
      "https://mirror.example.com/acme/mirror.git?x=1",
      "ssh://git@mirror.example.com/acme/mirror.git",
      "not an address",
    ]) {
      const refused = await world.call("POST", `${repo}/mirrors`, {
        as: alice,
        body: { ...body, url },
      });
      expect(refused.status, url).toBe(422);
      expect(JSON.stringify(refused.body)).not.toContain(CREDENTIAL);
    }
    const badPattern = await world.call("POST", `${repo}/mirrors`, {
      as: alice,
      body: { ...body, exclude: ["refs/pull/*"] },
    });
    expect(badPattern.status).toBe(422);
  });

  it("seals the credential and never gives it back", async () => {
    const made = await world.call("POST", `${repo}/mirrors`, {
      as: alice,
      body: { url: `${PUBLIC_URL}/`, credential: CREDENTIAL, exclude: ["dependabot/**"] },
    });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({
      url: PUBLIC_URL,
      username: USER,
      exclude: ["dependabot/**"],
      force: true,
      enabled: true,
      pending: true,
      lastStatus: null,
    });
    const listed = await world.call("GET", `${repo}/mirrors`, { as: alice });
    expect(listed.body.mirrors).toHaveLength(1);
    expect(JSON.stringify([made.body, listed.body])).not.toContain(CREDENTIAL);
    const row = await rowOf(made.body.id);
    expect(JSON.stringify(row)).not.toContain(CREDENTIAL);
    expect(row.credentialEncrypted.startsWith("v2:")).toBe(true);

    expect(
      (
        await world.call("POST", `${repo}/mirrors`, {
          as: alice,
          body: { url: PUBLIC_URL, credential: "another" },
        })
      ).status,
    ).toBe(409);

    // A new address needs the credential again: a stored one is not sent somewhere new.
    const path = `${repo}/mirrors/${made.body.id}`;
    const moved = { url: "https://elsewhere.example.com/acme/mirror.git" };
    expect((await world.call("PATCH", path, { as: alice, body: moved })).status).toBe(422);
    const changed = await world.call("PATCH", path, {
      as: alice,
      body: { ...moved, credential: "a-second-credential", force: false, enabled: false },
    });
    expect(changed.body).toMatchObject({ url: moved.url, force: false, enabled: false });
    expect(JSON.stringify(changed.body)).not.toContain("a-second-credential");

    expect((await world.call("DELETE", path, { as: bob })).status).toBe(403);
    expect((await world.call("DELETE", path, { as: alice })).status).toBe(200);
    expect((await world.call("DELETE", path, { as: alice })).status).toBe(404);
  });

  it("pushes after a push here, and records the run", async () => {
    const mirrorId = await addMirror();
    expect(await mirrorsDue()).toContain(mirrorId);
    expect(await runMirrorJob(world.env, mirrorId, deps())).toEqual({});
    const refs = await targetRefs();
    expect(refs["refs/heads/main"]).toBe(await gitOut(["rev-parse", "main"], { cwd: work }));
    expect(refs["refs/tags/v1"]).toBe(await gitOut(["rev-parse", "v1"], { cwd: work }));
    let row = await rowOf(mirrorId);
    expect(row).toMatchObject({
      lastStatus: "ok",
      lastError: null,
      attempts: 0,
      leaseToken: null,
      leaseUntil: null,
    });
    expect(row.syncedGeneration).toBe(row.pendingGeneration);
    expect(row.lastSyncedAt).not.toBeNull();
    expect(row.lastResult).toMatchObject({ created: 2, updated: 0, deleted: 0, refused: [] });
    expect(await mirrorsDue()).not.toContain(mirrorId);
    // Nothing owed: a message that arrives now does nothing.
    const before = backend.requests.length;
    expect(await runMirrorJob(world.env, mirrorId, deps())).toEqual({});
    expect(backend.requests.length).toBe(before);

    // A push here asks for a run, twice delivered or not.
    const head = await commitFile(work, "next.txt", "next\n", "next");
    await git(["push", "-q", "origin", "main"], { cwd: work });
    await pushEvent();
    await pushEvent();
    row = await rowOf(mirrorId);
    expect(row.pendingGeneration).toBeGreaterThan(row.syncedGeneration);
    expect(await mirrorsDue()).toContain(mirrorId);
    // No queue is bound here, so the sweep runs what is due itself... against
    // the real Durable Object, which a test has not got: run the job directly.
    expect(await runMirrorJob(world.env, mirrorId, deps())).toEqual({});
    expect((await targetRefs())["refs/heads/main"]).toBe(head);

    const listed = await world.call("GET", `${repo}/mirrors`, { as: alice });
    expect(listed.body.mirrors[0]).toMatchObject({
      pending: false,
      running: false,
      lastStatus: "ok",
      lastResult: { updated: 1 },
    });
    expect(listed.body.mirrors[0].lastSyncedAt).toEqual(expect.any(String));

    // Sync now asks for a run whatever the state.
    const asked = await world.call("POST", `${repo}/mirrors/${mirrorId}/sync`, { as: alice });
    expect(asked.body.pending).toBe(true);
  });

  it("never lets a run of an older push land after a newer one", async () => {
    const mirrorId = await addMirror();
    await runMirrorJob(world.env, mirrorId, deps());

    const older = await commitFile(work, "older.txt", "older\n", "the older push");
    await git(["push", "-q", "origin", "main"], { cwd: work });
    await pushEvent();

    // The first run is held just before its push reaches the target.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const atPush = new Promise<void>((resolve) => (reached = resolve));
    backend.behave({
      beforePush: async () => {
        backend.behave({ beforePush: null });
        reached();
        await held;
      },
    });
    const first = runMirrorJob(world.env, mirrorId, deps());
    await atPush;

    // Meanwhile a newer push lands here, and its message arrives.
    const newer = await commitFile(work, "newer.txt", "newer\n", "the newer push");
    await git(["push", "-q", "origin", "main"], { cwd: work });
    await pushEvent();
    const pushesBefore = backend.requests.length;
    // The mirror is held: the second message does nothing at all.
    expect(await runMirrorJob(world.env, mirrorId, deps())).toEqual({});
    expect(backend.requests.length).toBe(pushesBefore);
    expect(await mirrorsDue()).not.toContain(mirrorId);

    release();
    // The first run lands the older state and says another run is owed.
    expect(await first).toEqual({ again: 0 });
    expect((await targetRefs())["refs/heads/main"]).toBe(older);
    const between = await rowOf(mirrorId);
    expect(between.pendingGeneration).toBeGreaterThan(between.syncedGeneration);
    expect(await runMirrorJob(world.env, mirrorId, deps())).toEqual({});
    expect((await targetRefs())["refs/heads/main"]).toBe(newer);
    const after = await rowOf(mirrorId);
    expect(after.syncedGeneration).toBe(after.pendingGeneration);
  });

  it("records a failure in words, waits longer each time, and logs no address or credential", async () => {
    const mirrorId = await addMirror({ credential: "the-wrong-credential-entirely" });
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      }),
    );
    try {
      expect(await runMirrorJob(world.env, mirrorId, deps())).toEqual({});
      let row = await rowOf(mirrorId);
      expect(row).toMatchObject({
        lastStatus: "error",
        lastError: "The remote refused the credential",
        attempts: 1,
        leaseToken: null,
      });
      expect(row.lastSyncedAt).toBeNull();
      const firstWait = row.nextAttemptAt.getTime() - Date.now();
      expect(firstWait).toBeGreaterThan(30_000);
      // Not due yet, so the sweep leaves it; a push tries at once all the same.
      expect(await mirrorsDue()).not.toContain(mirrorId);
      expect((await sweepJobs(world.env, { reconcile: false })).sent).toBe(0);
      expect(await runMirrorJob(world.env, mirrorId, deps())).toEqual({});
      row = await rowOf(mirrorId);
      expect(row.attempts).toBe(2);
      expect(row.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(firstWait + 30_000);

      const listed = await world.call("GET", `${repo}/mirrors`, { as: alice });
      expect(listed.body.mirrors[0]).toMatchObject({
        lastStatus: "error",
        lastError: "The remote refused the credential",
        pending: true,
      });
      expect(listed.body.mirrors[0].nextAttemptAt).toEqual(expect.any(String));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const text = logged.join("\n");
    expect(text).toContain(mirrorId);
    expect(text).not.toContain("the-wrong-credential-entirely");
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("mirror.git");
    expect(text).not.toContain("Basic");

    // The right credential, entered again, is tried at once and works.
    const fixed = await world.call("PATCH", `${repo}/mirrors/${mirrorId}`, {
      as: alice,
      body: { credential: CREDENTIAL },
    });
    expect(fixed.status).toBe(200);
    expect(await mirrorsDue()).toContain(mirrorId);
    await runMirrorJob(world.env, mirrorId, deps());
    expect(await rowOf(mirrorId)).toMatchObject({ lastStatus: "ok", lastError: null, attempts: 0 });
  });

  it("stops a run whose mirror was removed, and pushes nothing for one that is off", async () => {
    const mirrorId = await addMirror();
    await runMirrorJob(world.env, mirrorId, deps());
    await commitFile(work, "late.txt", "late\n", "late");
    await git(["push", "-q", "origin", "main"], { cwd: work });
    await pushEvent();
    const before = await targetRefs();

    await world.call("PATCH", `${repo}/mirrors/${mirrorId}`, {
      as: alice,
      body: { enabled: false },
    });
    const requests = backend.requests.length;
    expect(await runMirrorJob(world.env, mirrorId, deps())).toEqual({});
    expect(backend.requests.length).toBe(requests);
    // A push while it is off asks for nothing.
    const generation = (await rowOf(mirrorId)).pendingGeneration;
    await pushEvent();
    expect((await rowOf(mirrorId)).pendingGeneration).toBe(generation);

    await world.call("PATCH", `${repo}/mirrors/${mirrorId}`, {
      as: alice,
      body: { enabled: true },
    });
    // Removed after the run has read the target's refs and before it pushes.
    const realFetch = deps().fetch!;
    const run = runMirrorJob(world.env, mirrorId, {
      ...deps(),
      fetch: async (url, init) => {
        const response = await realFetch(url, init);
        if (init.method === "GET") {
          await db.delete(gitPushMirrors).where(eq(gitPushMirrors.id, mirrorId));
        }
        return response;
      },
    });
    expect(await run).toEqual({});
    expect(await targetRefs()).toEqual(before);
  });
});
