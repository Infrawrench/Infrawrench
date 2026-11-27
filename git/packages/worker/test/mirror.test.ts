/**
 * A push mirror's run, end to end with the real `git` on both sides: `git`
 * pushes to the repository's storage (the Node stand-ins), `syncMirror`
 * pushes from there to a bare repository behind `git http-backend`, and the
 * two are compared ref for ref and object for object.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HttpBackend, startHttpBackend } from "../../protocol/test/http-backend";
import { basicAuthorization } from "../src/mirror/address";
import { type MirrorSyncOptions, type MirrorTarget, syncMirror } from "../src/mirror/sync";
import {
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
import { type NodeRepo, startNodeRepo } from "./support/node-server";

afterAll(cleanupTempDirs);

const hasBackend = hasGit && spawnSync("git", ["http-backend"], { input: "" }).error === undefined;
const describeGit = describe.skipIf(!hasBackend);

const USER = "x-access-token";
const CREDENTIAL = "mirror-test-credential-not-a-real-one";

describeGit("a push mirror with git on both sides", () => {
  let repo: NodeRepo;
  let work: string;
  let backend: HttpBackend;
  let root: string;
  let bare: string;
  let target: MirrorTarget;

  const options = (extra: Partial<MirrorSyncOptions> = {}): MirrorSyncOptions => ({
    fetch: (url, init) => fetch(url, init),
    deadline: Date.now() + 120_000,
    ...extra,
  });
  const sync = (extra: Partial<MirrorSyncOptions> = {}, to: Partial<MirrorTarget> = {}) =>
    syncMirror(repo.repository, { ...target, ...to }, options(extra));
  const refsOf = async (cwd: string): Promise<Record<string, string>> =>
    Object.fromEntries(
      (await gitOut(["for-each-ref", "--format=%(refname) %(objectname)"], { cwd }))
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ") as [string, string]),
    );
  const forgeRefs = (): Record<string, string> =>
    Object.fromEntries(
      repo.repository
        .listRefs()
        .filter((ref) => /^refs\/(heads|tags)\//.test(ref.name))
        .map((ref) => [ref.name, ref.oid]),
    );
  const pushes = (): number =>
    backend.requests.filter(
      (request) => request.method === "POST" && request.url.endsWith("/git-receive-pack"),
    ).length;

  beforeEach(async () => {
    resetClock();
    repo = await startNodeRepo();
    work = await initRepo("mirror-work");
    for (let i = 0; i < 4; i++) {
      await commitFile(work, `src/file-${i % 2}.txt`, `line ${i}\n`.repeat(200 + i), `c${i}`);
    }
    await git(["tag", "-a", "-m", "first release", "v1", "HEAD~1"], { cwd: work });
    await git(["tag", "light", "HEAD~2"], { cwd: work });
    await git(["branch", "topic", "HEAD~1"], { cwd: work });
    await git(["remote", "add", "origin", repo.url], { cwd: work });
    await git(["push", "-q", "origin", "--all"], { cwd: work });
    await git(["push", "-q", "origin", "--tags"], { cwd: work });

    root = tempDir("mirror-target");
    bare = join(root, "mirror.git");
    await git(["init", "-q", "--bare", bare]);
    backend = await startHttpBackend({ root, username: USER, password: CREDENTIAL });
    target = {
      url: `${backend.origin}/mirror.git`,
      authorization: basicAuthorization(USER, CREDENTIAL),
      exclude: [],
      force: true,
    };
  });
  afterEach(async () => {
    expect(repo.errors).toEqual([]);
    await backend.close();
    await repo.close();
  });

  it("brings an empty target to the same branches, tags and object ids", async () => {
    const outcome = await sync();
    expect(outcome).toMatchObject({ status: "ok", error: null });
    expect(outcome.result).toMatchObject({ created: 4, updated: 0, deleted: 0, refused: [] });
    expect(await refsOf(bare)).toEqual(forgeRefs());
    expect(await refsOf(bare)).toEqual(await refsOf(work).then(withoutRemotes));
    await git(["fsck", "--strict", "--full"], { cwd: bare });
    // An annotated tag arrives as its tag object, a lightweight one as the commit.
    expect(await gitOut(["cat-file", "-t", "refs/tags/v1"], { cwd: bare })).toBe("tag");
    expect(await gitOut(["cat-file", "-t", "refs/tags/light"], { cwd: bare })).toBe("commit");
    // Nothing was rewritten: the same objects, id for id.
    expect(
      await gitOut(["rev-list", "--objects", "--all", "--no-object-names"], { cwd: bare }),
    ).toBe(await gitOut(["rev-list", "--objects", "--all", "--no-object-names"], { cwd: work }));

    // A second run finds nothing to do and pushes nothing.
    const before = pushes();
    expect(await sync()).toMatchObject({
      status: "ok",
      result: { created: 0, updated: 0, deleted: 0 },
    });
    expect(pushes()).toBe(before);
  });

  it("sends only what is new after a push, and follows a force push and deletions", async () => {
    await sync();
    const head = await commitFile(work, "src/new.txt", "new\n", "one more");
    await git(["push", "-q", "origin", "main"], { cwd: work });
    let sent = 0;
    backend.behave({ onPush: (bytes) => (sent = bytes) });
    expect(await sync()).toMatchObject({ status: "ok", result: { updated: 1, created: 0 } });
    expect((await refsOf(bare))["refs/heads/main"]).toBe(head);
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(1500);

    // History rewritten here, a branch and a tag deleted, a tag moved.
    await git(["reset", "-q", "--hard", "HEAD~2"], { cwd: work });
    const rewritten = await commitFile(work, "src/other.txt", "other\n", "another way");
    await git(["push", "-q", "--force", "origin", "main"], { cwd: work });
    await git(["push", "-q", "origin", ":topic", ":refs/tags/light"], { cwd: work });
    await git(["tag", "-f", "-a", "-m", "second release", "v1", "HEAD"], { cwd: work });
    await git(["push", "-q", "--force", "origin", "refs/tags/v1"], { cwd: work });
    const outcome = await sync();
    expect(outcome).toMatchObject({ status: "ok", result: { updated: 2, deleted: 2 } });
    expect(await refsOf(bare)).toEqual(forgeRefs());
    expect((await refsOf(bare))["refs/heads/main"]).toBe(rewritten);
    expect(Object.keys(await refsOf(bare)).sort()).toEqual(["refs/heads/main", "refs/tags/v1"]);
    await git(["fsck", "--strict", "--full"], { cwd: bare });
  });

  it("without force only creates and fast-forwards, and says what it left alone", async () => {
    await sync();
    // The target gains a branch and a commit of its own; here history is rewritten.
    const other = join(tempDir("mirror-other"), "other");
    await git(["clone", "-q", "-b", "main", bare, other]);
    const theirs = await commitFile(other, "theirs.txt", "theirs\n", "made on the target");
    await git(["push", "-q", "origin", "HEAD:main", "HEAD:only-there"], { cwd: other });
    await git(["reset", "-q", "--hard", "HEAD~1"], { cwd: work });
    await commitFile(work, "src/ours.txt", "ours\n", "made here");
    await git(["push", "-q", "--force", "origin", "main"], { cwd: work });
    const ahead = await commitFile(work, "src/topic.txt", "topic\n", "on topic");
    await git(["push", "-q", "origin", "HEAD:topic"], { cwd: work });

    const outcome = await sync({}, { force: false });
    expect(outcome.status).toBe("ok");
    const refs = await refsOf(bare);
    expect(refs["refs/heads/main"]).toBe(theirs);
    expect(refs["refs/heads/only-there"]).toBe(theirs);
    // `topic` moved forward here, which is a fast-forward there... but it was at HEAD~1, an ancestor.
    expect(refs["refs/heads/topic"]).toBe(ahead);
    expect(outcome.result.refused.map((entry) => entry.ref).sort()).toEqual([
      "refs/heads/main",
      "refs/heads/only-there",
    ]);

    // With force the target is made equal again.
    expect((await sync()).status).toBe("ok");
    expect(await refsOf(bare)).toEqual(forgeRefs());
  });

  it("leaves excluded refs alone on both sides", async () => {
    await git(["push", "-q", "origin", "main:refs/heads/plugingen/aws"], { cwd: work });
    const other = join(tempDir("mirror-bot"), "other");
    await git(["init", "-q", "-b", "main", other]);
    const bot = await commitFile(other, "bot.txt", "bot\n", "a bot's branch");
    await git(["push", "-q", bare, "HEAD:refs/heads/dependabot/npm/left-pad"], { cwd: other });

    const outcome = await sync(
      {},
      { exclude: ["dependabot/**", "refs/heads/plugingen/*", "light"] },
    );
    expect(outcome).toMatchObject({ status: "ok", result: { deleted: 0, refused: [] } });
    const refs = await refsOf(bare);
    expect(refs["refs/heads/dependabot/npm/left-pad"]).toBe(bot);
    expect(refs["refs/heads/plugingen/aws"]).toBeUndefined();
    expect(refs["refs/tags/light"]).toBeUndefined();
    expect(refs["refs/tags/v1"]).toBe(forgeRefs()["refs/tags/v1"]);
  });

  it("pushes a long history in parts, each a commit of the branch, and tags three at a time", async () => {
    const commits: string[] = [];
    for (let i = 0; i < 45; i++) {
      commits.push(await commitFile(work, `long/${i % 5}.txt`, `${i}\n`.repeat(50), `long ${i}`));
      if (i % 5 === 0) await git(["tag", `step-${i}`], { cwd: work });
    }
    await git(["push", "-q", "origin", "main"], { cwd: work });
    await git(["push", "-q", "origin", "--tags"], { cwd: work });

    const outcome = await sync({ limits: { stepCommits: 10 } });
    expect(outcome.status).toBe("ok");
    expect(await refsOf(bare)).toEqual(forgeRefs());
    await git(["fsck", "--strict", "--full"], { cwd: bare });
    // 49 commits in parts of about ten for main (five pushes), then `topic` and
    // eleven tags, no more than three tags a push (four pushes).
    const count = pushes();
    expect(count).toBe(5 + 4);
    // The target's reflog would show it: every value main took is an ancestor of its head.
    expect(outcome.result.refs).toContain("refs/heads/main");
  });

  it("cuts the parts smaller when one push would be too large, and gives up with a sentence", async () => {
    for (let i = 0; i < 12; i++) {
      await commitFile(work, `big/${i}.bin`, randomBytes(40_000, i + 1), `big ${i}`);
    }
    await git(["push", "-q", "origin", "main"], { cwd: work });
    // Twelve commits of 40 kB each: one push of them all is over the limit, three at a time are not.
    const outcome = await sync({
      limits: { stepCommits: 12, minStepCommits: 2, maxPackBytes: 150_000 },
    });
    expect(outcome.status).toBe("ok");
    expect(await refsOf(bare)).toEqual(forgeRefs());
    await git(["fsck", "--strict", "--full"], { cwd: bare });

    await commitFile(work, "big/huge.bin", randomBytes(400_000, 99), "one commit too large");
    await git(["push", "-q", "origin", "main"], { cwd: work });
    const failed = await sync({
      limits: { stepCommits: 4, minStepCommits: 2, maxPackBytes: 150_000 },
    });
    expect(failed.status).toBe("error");
    expect(failed.error).toMatch(/larger than one push/);
  });

  it("does not overwrite a ref the target moved between its advertisement and the push", async () => {
    await sync();
    await commitFile(work, "src/ours.txt", "ours\n", "pushed here");
    await git(["push", "-q", "origin", "main"], { cwd: work });
    // A newer run got there first: the target's main moves before this push lands.
    const other = join(tempDir("mirror-race"), "other");
    await git(["clone", "-q", "-b", "main", bare, other]);
    const newer = await commitFile(other, "newer.txt", "newer\n", "a newer state");
    backend.behave({
      beforePush: async () => {
        backend.behave({ beforePush: null });
        await git(["push", "-q", "origin", "HEAD:main"], { cwd: other });
      },
    });
    const outcome = await sync();
    expect(outcome.status).toBe("error");
    expect(outcome.result.refused.map((entry) => entry.ref)).toEqual(["refs/heads/main"]);
    expect((await refsOf(bare))["refs/heads/main"]).toBe(newer);
  });

  it("stops before pushing once another run has taken over, and at its deadline", async () => {
    const before = pushes();
    expect((await sync({ stillMine: async () => false })).status).toBe("superseded");
    expect(pushes()).toBe(before);
    expect(await refsOf(bare)).toEqual({});

    // A deadline already passed: nothing is started, and the next run does it all.
    expect((await sync({ deadline: Date.now() - 1 })).status).toBe("partial");
    expect(await refsOf(bare)).toEqual({});
    expect((await sync()).status).toBe("ok");
    expect(await refsOf(bare)).toEqual(forgeRefs());
  });

  it("reports failures in words that carry neither the address nor the credential", async () => {
    const wrong = await sync({}, { authorization: basicAuthorization(USER, "wrong") });
    expect(wrong).toMatchObject({ status: "error", error: "The remote refused the credential" });
    backend.behave({ status: 404 });
    const missing = await sync();
    backend.behave({ status: null });
    const down = await sync({}, { url: "http://127.0.0.1:9/nothing.git" });
    const redirected = await (async () => {
      backend.behave({ redirect: "http://127.0.0.1:9/elsewhere" });
      try {
        return await sync();
      } finally {
        backend.behave({ redirect: null });
      }
    })();
    expect(missing.error).toMatch(/no such repository/);
    expect(down.error).toBe("The target could not be reached");
    expect(redirected.error).toMatch(/redirect/);
    for (const outcome of [wrong, missing, down, redirected]) {
      expect(outcome.status).toBe("error");
      const text = JSON.stringify(outcome);
      expect(text).not.toContain("127.0.0.1");
      expect(text).not.toContain(CREDENTIAL);
      expect(text).not.toContain("Basic");
    }
    // Every request that reached the target carried the credential and nothing else of ours.
    expect(backend.requests.every((request) => request.authorization !== null)).toBe(true);
  });
});

/** A work tree's refs without its remote-tracking ones. */
const withoutRemotes = (refs: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(refs).filter(([name]) => !name.startsWith("refs/remotes/")));
