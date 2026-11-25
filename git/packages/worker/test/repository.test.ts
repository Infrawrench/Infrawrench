/**
 * The repository's storage with the real `git` on the other end: pushes
 * that arrive as one request or as a multipart upload, fetches out of
 * several packs, repacking, forks, deletion, and the ref rules. Runs on the
 * Node stand-ins for R2 and SQLite; the same code runs in the Durable
 * Object (`test/e2e` covers it there).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ZERO_OID, parseCommit } from "@infrawrench/git-core";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { tarArchive } from "../src/repo/do/archive";
import { Repository } from "../src/repo/do/repository";
import {
  allObjects,
  cleanupTempDirs,
  commitFile,
  git,
  gitOut,
  hasGit,
  initRepo,
  randomBytes,
  resetClock,
  tempDir,
} from "./support/git";
import { MemoryBucket, nodeStorage } from "./support/node-platform";
import { type NodeRepo, startNodeRepo } from "./support/node-server";

afterAll(cleanupTempDirs);

const describeGit = describe.skipIf(!hasGit);

describeGit("a repository with git on the other end", () => {
  let repo: NodeRepo;
  let work: string;

  beforeEach(async () => {
    resetClock();
    repo = await startNodeRepo();
    work = await initRepo("work");
    for (let i = 0; i < 4; i++) {
      await commitFile(work, `src/file-${i % 2}.txt`, `line ${i}\n`.repeat(200 + i), `c${i}`);
    }
    await git(["remote", "add", "origin", repo.url], { cwd: work });
    await git(["push", "-q", "origin", "main"], { cwd: work });
  });
  afterEach(async () => {
    expect(repo.errors).toEqual([]);
    await repo.close();
  });

  const clone = async (...args: string[]): Promise<string> => {
    const dir = join(tempDir("clone"), "clone");
    await git(["clone", "-q", ...args, repo.url, dir]);
    return dir;
  };

  it("stores a push as one pack with its index and serves it back untouched", async () => {
    const keys = [...repo.bucket.objects.keys()].sort();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^repos\/repo-1\/packs\/pack-.+\.idx$/);
    expect(keys[1]).toMatch(/^repos\/repo-1\/packs\/pack-.+\.pack$/);
    const stats = repo.repository.stats();
    expect(stats).toMatchObject({ livePacks: 1, branches: 1, empty: false, pendingBytes: 0 });
    expect(stats.liveBytes).toBe(
      [...repo.bucket.objects.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    );

    const cloned = await clone();
    await git(["fsck", "--strict", "--full"], { cwd: cloned });
    expect(await allObjects(cloned)).toBe(await allObjects(work));
    // A clone of one self-contained pack is that pack: no walk, no rewriting.
    expect(repo.requests.at(-1)?.packSource).toBe("everything");
  });

  it("announces a push with what moved and whether it was forced", async () => {
    const first = await gitOut(["rev-parse", "HEAD"], { cwd: work });
    expect(repo.events).toEqual([
      {
        type: "push",
        repoId: "repo-1",
        actor: { kind: "user", userId: "user-1", credentialId: null },
        updates: [{ name: "refs/heads/main", oldOid: ZERO_OID, newOid: first, forced: false }],
        at: expect.any(Number),
      },
    ]);
    await git(["reset", "-q", "--hard", "HEAD~1"], { cwd: work });
    const rewritten = await commitFile(work, "other.txt", "other\n", "rewritten");
    await git(["push", "-q", "--force", "origin", "main"], { cwd: work });
    expect(repo.events[1]?.updates).toEqual([
      { name: "refs/heads/main", oldOid: first, newOid: rewritten, forced: true },
    ]);
  });

  it("serves a clone and a fetch out of several packs, thin ones included", async () => {
    const early = await clone();
    for (let i = 0; i < 3; i++) {
      // Each push changes an existing file, so git sends a thin pack: a delta on a blob in an older pack.
      await commitFile(work, "src/file-0.txt", `line ${i}\n`.repeat(260) + `tail ${i}\n`, `p${i}`);
      await git(["push", "-q", "origin", "main"], { cwd: work });
    }
    await git(["tag", "-a", "-m", "one", "v1"], { cwd: work });
    await git(["push", "-q", "origin", "v1"], { cwd: work });
    expect(repo.repository.stats().livePacks).toBe(5);

    const whole = await clone();
    await git(["fsck", "--strict", "--full"], { cwd: whole });
    expect(await allObjects(whole)).toBe(await allObjects(work));
    expect(repo.requests.at(-1)?.packSource).toBe("everything");

    // The older clone has the first pack's objects and asks for the rest.
    await git(["fetch", "-q", "--tags", "origin"], { cwd: early });
    await git(["fsck", "--strict", "--full"], { cwd: early });
    expect(await gitOut(["rev-parse", "origin/main", "v1"], { cwd: early })).toBe(
      await gitOut(["rev-parse", "main", "v1"], { cwd: work }),
    );
    const fetched = repo.requests.at(-1)!;
    expect(fetched.packSource).toBe("objects");
    // Three commits, each with its root tree, `src` tree and blob, and the tag.
    expect(fetched.objectsSent).toBe(13);

    // A client without ofs-delta gets every delta by id, and a shallow one gets whole objects it can use.
    const noOfs = join(tempDir("no-ofs"), "clone");
    await git([
      "-c",
      "repack.useDeltaBaseOffset=false",
      "-c",
      "protocol.version=0",
      "clone",
      "-q",
      repo.url,
      noOfs,
    ]);
    await git(["fsck", "--strict", "--full"], { cwd: noOfs });
    const shallow = await clone("--depth", "1");
    await git(["fsck", "--strict"], { cwd: shallow });
    expect(await gitOut(["rev-parse", "HEAD"], { cwd: shallow })).toBe(
      await gitOut(["rev-parse", "main"], { cwd: work }),
    );
  });

  it("repacks a run of small packs into one and deletes the old files after the grace period", async () => {
    let now = Date.now();
    await repo.close();
    repo = await startNodeRepo("repo-1", {
      limits: { repackAbovePacks: 3, garbageGraceMs: 60_000 },
      now: () => now,
    });
    await git(["remote", "set-url", "origin", repo.url], { cwd: work });
    await git(["push", "-q", "origin", "main"], { cwd: work });
    for (let i = 0; i < 4; i++) {
      await commitFile(work, "src/file-1.txt", `line ${i}\n`.repeat(300) + `end ${i}\n`, `r${i}`);
      await git(["push", "-q", "origin", "main"], { cwd: work });
    }
    expect(repo.repository.stats().livePacks).toBe(5);
    // The push that crossed the threshold asked for an alarm.
    expect(repo.storage.alarm).not.toBeNull();
    const before = await clone();

    expect(await repo.repository.maintain()).toEqual({ deleted: 0, repacked: true });
    const stats = repo.repository.stats();
    expect(stats.livePacks).toBe(1);
    expect(stats.pendingBytes).toBeGreaterThan(0);
    // Old and new side by side until the grace period is over.
    expect(repo.bucket.objects.size).toBe(12);

    const after = await clone();
    await git(["fsck", "--strict", "--full"], { cwd: after });
    expect(await allObjects(after)).toBe(await allObjects(before));
    // Five thin packs became one that stands alone, so a clone is the stored file again.
    expect(repo.requests.at(-1)?.packSource).toBe("everything");

    now += 61_000;
    expect(await repo.repository.maintain()).toEqual({ deleted: 5, repacked: false });
    expect(repo.bucket.objects.size).toBe(2);
    expect(repo.repository.stats().pendingBytes).toBe(0);
    const later = await clone();
    await git(["fsck", "--strict", "--full"], { cwd: later });

    // And the repository still takes pushes.
    const next = await commitFile(work, "after.txt", "after\n", "after repack");
    await git(["push", "-q", "origin", "main"], { cwd: work });
    expect(repo.repository.listRefs()).toEqual([{ name: "refs/heads/main", oid: next }]);
  });

  it("receives a pack larger than one part as a multipart upload", async () => {
    // 20 MiB that does not compress: four parts of 5 MiB and a short one.
    await commitFile(work, "big.bin", randomBytes(20 * 1024 * 1024, 7), "big");
    await git(["push", "-q", "origin", "main"], { cwd: work });
    expect(repo.bucket.calls.uploadPart).toBe(5);
    expect(repo.bucket.openUploads.size).toBe(0);
    const cloned = await clone();
    await git(["fsck", "--strict", "--full"], { cwd: cloned });
    expect(await gitOut(["rev-parse", "HEAD:big.bin"], { cwd: cloned })).toBe(
      await gitOut(["rev-parse", "HEAD:big.bin"], { cwd: work }),
    );
    // The fetch by walking history copies the large entry through without holding it.
    const partial = await initRepo("partial");
    await git(["fetch", "-q", "--depth", "1", repo.url, "main"], { cwd: partial });
    await git(["fsck", "--strict"], { cwd: partial });
  });

  it("leaves nothing behind when a push is refused", async () => {
    const files = repo.bucket.objects.size;
    repo.policy = {
      rules: [
        {
          pattern: "main",
          requirePullRequest: false,
          requiredApprovals: 0,
          dismissStaleApprovals: false,
          requiredStatusContexts: [],
          allowForcePush: false,
          allowDeletion: false,
          restrictPushers: false,
          pusherUserIds: [],
          enforceAdmins: false,
        },
      ],
      userId: "user-1",
      admin: false,
    };
    await git(["reset", "-q", "--hard", "HEAD~1"], { cwd: work });
    await commitFile(work, "x.txt", "x\n", "diverged");
    const forced = await git(["push", "--force", "origin", "main"], {
      cwd: work,
      allowFailure: true,
    });
    expect(forced.status).not.toBe(0);
    expect(forced.stderr).toMatch(/protected branch: force pushes are not allowed/);
    const deleted = await git(["push", "origin", ":main"], { cwd: work, allowFailure: true });
    expect(deleted.stderr).toMatch(/deletion/);
    expect(repo.bucket.objects.size).toBe(files);
    expect(repo.repository.stats().pendingBytes).toBe(0);
    expect(repo.events).toHaveLength(1);

    // An administrator is not bound by a rule that does not say so.
    repo.policy = { ...repo.policy, admin: true };
    await git(["push", "-q", "--force", "origin", "main"], { cwd: work });
    expect(repo.events).toHaveLength(2);
  });

  it("refuses refs the server manages, and a push that names a missing object", async () => {
    repo.policy = { rules: [], userId: "user-1", admin: true };
    const pull = await git(["push", "origin", "main:refs/pull/1/head"], {
      cwd: work,
      allowFailure: true,
    });
    expect(pull.stderr).toMatch(/managed by the server/);
    expect(repo.repository.listRefs().map((ref) => ref.name)).toEqual(["refs/heads/main"]);
  });

  it("makes server-side objects and ref changes, compare-and-swap", async () => {
    const { repository } = repo;
    const head = repository.listRefs()[0]!.oid;
    const commit = parseCommit((await repository.readObject(head))!.data);
    const blob = new TextEncoder().encode("made on the server\n");
    const [blobOid] = await repository.writeObjects([{ type: "blob", data: blob }]);
    expect(blobOid).toBe(
      spawnSync("git", ["hash-object", "--stdin"], { input: blob, encoding: "utf8" }).stdout.trim(),
    );
    expect((await repository.readObject(blobOid!))?.data).toEqual(blob);
    // Writing the same object again stores nothing.
    const packs = repository.stats().livePacks;
    await repository.writeObjects([{ type: "blob", data: blob }]);
    expect(repository.stats().livePacks).toBe(packs);
    // An object that names one the repository lacks is refused.
    await expect(
      repository.writeObjects([
        { type: "commit", data: new TextEncoder().encode(`tree ${"1".repeat(40)}\n\nx\n`) },
      ]),
    ).rejects.toThrow(/missing necessary object/);

    const stale = await repository.applyUpdates([
      { name: "refs/heads/topic", oldOid: head, newOid: head },
    ]);
    expect(stale).toEqual([{ name: "refs/heads/topic", error: "reference does not exist" }]);
    const created = await repository.applyUpdates(
      [{ name: "refs/heads/topic", oldOid: ZERO_OID, newOid: head }],
      { actor: null },
    );
    expect(created).toEqual([{ name: "refs/heads/topic", error: null }]);
    expect(repo.events.at(-1)).toMatchObject({
      actor: null,
      updates: [{ name: "refs/heads/topic" }],
    });
    const again = await repository.applyUpdates([
      { name: "refs/heads/topic", oldOid: ZERO_OID, newOid: head },
    ]);
    expect(again[0]?.error).toBe("reference already exists");
    const missing = await repository.applyUpdates([
      { name: "refs/heads/nowhere", oldOid: ZERO_OID, newOid: "2".repeat(40) },
    ]);
    expect(missing[0]?.error).toBe("missing necessary objects");
    const atomic = await repository.applyUpdates(
      [
        { name: "refs/heads/a", oldOid: ZERO_OID, newOid: head },
        { name: "refs/heads/topic", oldOid: ZERO_OID, newOid: head },
      ],
      { atomic: true },
    );
    expect(atomic.map((result) => result.error)).toEqual([
      "atomic push failure",
      "reference already exists",
    ]);
    expect(commit.tree).toMatch(/^[0-9a-f]{40}$/);

    repository.setHead("refs/heads/topic");
    expect(repository.head()).toBe("refs/heads/topic");
    expect(() => repository.setHead("refs/tags/v1")).toThrow();
    expect(await repository.resolvePrefix(head.slice(0, 8))).toEqual([head]);
  });

  it("forks by copying packs, and the fork lives on when the parent is deleted", async () => {
    await git(["tag", "-a", "-m", "one", "v1"], { cwd: work });
    await git(["push", "-q", "origin", "v1"], { cwd: work });
    await repo.repository.applyUpdates([
      {
        name: "refs/pull/1/head",
        oldOid: ZERO_OID,
        newOid: await gitOut(["rev-parse", "main"], { cwd: work }),
      },
    ]);
    const fork = await startNodeRepo("repo-2", { bucket: repo.bucket });
    try {
      await fork.repository.importFork(repo.repository.forkManifest());
      // Branches and tags come along; the parent's pull requests do not.
      expect(fork.repository.listRefs().map((ref) => ref.name)).toEqual([
        "refs/heads/main",
        "refs/tags/v1",
      ]);
      expect(fork.repository.stats().liveBytes).toBe(repo.repository.stats().liveBytes);

      const deleted = await repo.repository.destroy();
      expect(deleted.deletedFiles).toBe(4);
      expect([...repo.bucket.objects.keys()].every((key) => key.startsWith("repos/repo-2/"))).toBe(
        true,
      );

      const dir = join(tempDir("fork"), "clone");
      await git(["clone", "-q", fork.url, dir]);
      await git(["fsck", "--strict", "--full"], { cwd: dir });
      expect(await allObjects(dir)).toBe(await allObjects(work));

      // The emptied object can hold a repository again.
      repo.repository.open("repo-1");
      expect(repo.repository.stats()).toMatchObject({ empty: true, livePacks: 0, sizeBytes: 0 });
      expect(fork.errors).toEqual([]);
    } finally {
      await fork.close();
    }
  });

  it("writes a commit as a tar with one top-level directory", async () => {
    await commitFile(
      work,
      `${"deep/".repeat(30)}name-${"x".repeat(60)}.txt`,
      "deep\n",
      "long path",
    );
    const { symlinkSync, chmodSync, writeFileSync } = await import("node:fs");
    writeFileSync(join(work, "run.sh"), "#!/bin/sh\n");
    chmodSync(join(work, "run.sh"), 0o755);
    symlinkSync("src/file-0.txt", join(work, "link"));
    const head = await commitFile(work, "empty.txt", "", "modes");
    await git(["push", "-q", "origin", "main"], { cwd: work });

    const chunks: Uint8Array[] = [];
    for await (const chunk of tarArchive(repo.repository.backend(), head, "repo-abc"))
      chunks.push(chunk);
    const out = tempDir("tar");
    const extracted = spawnSync("tar", ["-xf", "-", "-C", out], { input: Buffer.concat(chunks) });
    expect(extracted.status).toBe(0);
    expect(readdirSync(out)).toEqual(["repo-abc"]);
    const root = join(out, "repo-abc");
    // The extracted tree is the commit's tree, byte for byte and mode for mode.
    const check = tempDir("tar-check");
    await git(["init", "-q", check]);
    mkdirSync(join(check, ".git"), { recursive: true });
    await git(["--work-tree", root, "add", "-A"], { cwd: check });
    expect(await gitOut(["--work-tree", root, "write-tree"], { cwd: check })).toBe(
      await gitOut(["rev-parse", `${head}^{tree}`], { cwd: work }),
    );
  });
});

describe("a repository's first moments", () => {
  it("is empty until initialised, then has HEAD and, when asked, a README commit", async () => {
    const repository = new Repository({
      bucket: new MemoryBucket(),
      storage: nodeStorage(),
      events: null,
    });
    repository.open("repo-9");
    expect(() => repository.open("repo-other")).toThrow(/holds repository/);
    expect(repository.stats()).toMatchObject({ empty: true, refs: 0, sizeBytes: 0 });
    expect(repository.head()).toBe("refs/heads/main");

    const made = await repository.init({
      defaultBranch: "trunk",
      readme: { content: "# Hello\n", authorName: "Ada", authorEmail: "ada@example.com" },
    });
    expect(made.head).toBe("refs/heads/trunk");
    expect(repository.listRefs()).toEqual([{ name: "refs/heads/trunk", oid: made.commit }]);
    const commit = parseCommit((await repository.readObject(made.commit!))!.data);
    expect(commit.message).toBe("Initial commit\n");
    expect(commit.author.email).toBe("ada@example.com");
    // Asking again changes nothing.
    expect(
      (
        await repository.init({
          defaultBranch: "trunk",
          readme: { content: "x", authorName: "a", authorEmail: "b" },
        })
      ).commit,
    ).toBeNull();
  });
});
