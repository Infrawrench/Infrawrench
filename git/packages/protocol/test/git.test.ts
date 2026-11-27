/**
 * The real `git` against this package: clone, fetch and push over the
 * stateless (HTTP) and stateful (stream) forms, in protocol v0, v1 and v2.
 */
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { MemoryBackend, type ReceiveUpdate, type RepositoryBackend } from "../src";
import {
  type TestServer,
  allObjects,
  cleanupTempDirs,
  commitFile,
  describeGit,
  git,
  gitOut,
  initRepo,
  nextDate,
  resetClock,
  startServer,
  tempDir,
} from "./helpers";

afterAll(cleanupTempDirs);

interface Fixture {
  readonly backend: MemoryBackend;
  readonly server: TestServer;
  /** The work tree the history was made in. */
  readonly source: string;
  readonly commits: string[];
}

/** Pushes a small history with a branch, a merge and two kinds of tag to a new server. */
async function fixture(): Promise<Fixture> {
  resetClock();
  const backend = new MemoryBackend();
  const server = await startServer(backend);
  const source = await initRepo("source");
  const commits: string[] = [];
  for (let i = 0; i < 6; i++) {
    commits.push(
      await commitFile(source, `dir/file-${i % 3}.txt`, `line ${i}\n`.repeat(50 + i), `c${i}`),
    );
  }
  await git(["checkout", "-q", "-b", "feature", commits[2]!], { cwd: source });
  commits.push(await commitFile(source, "feature.txt", "feature\n", "feature work"));
  await git(["checkout", "-q", "main"], { cwd: source });
  const mergeDate = nextDate();
  await git(["merge", "-q", "--no-ff", "-m", "merge feature", "feature"], {
    cwd: source,
    env: { GIT_AUTHOR_DATE: mergeDate, GIT_COMMITTER_DATE: mergeDate },
  });
  commits.push(await gitOut(["rev-parse", "HEAD"], { cwd: source }));
  await git(["tag", "light", commits[1]!], { cwd: source });
  await git(["tag", "-a", "-m", "release", "v1", commits[3]!], { cwd: source });
  await git(["remote", "add", "origin", server.httpUrl], { cwd: source });
  await git(["push", "-q", "origin", "--all"], { cwd: source });
  await git(["push", "-q", "origin", "--tags"], { cwd: source });
  server.requests.length = 0;
  return { backend, server, source, commits };
}

let current: Fixture;
beforeEach(async () => {
  current = await fixture();
});
afterEach(async () => {
  expect(current.server.errors).toEqual([]);
  await current.server.close();
});

const transports = [
  { name: "http v0", url: (s: TestServer) => s.httpUrl, version: 0 },
  { name: "http v1", url: (s: TestServer) => s.httpUrl, version: 1 },
  { name: "http v2", url: (s: TestServer) => s.httpUrl, version: 2 },
  { name: "stream v0", url: (s: TestServer) => s.streamUrl, version: 0 },
  { name: "stream v1", url: (s: TestServer) => s.streamUrl, version: 1 },
  { name: "stream v2", url: (s: TestServer) => s.streamUrl, version: 2 },
] as const;

describeGit.each(transports)("clone and fetch over $name", ({ url, version }) => {
  const v = ["-c", `protocol.version=${version}`];

  it("clones everything and the clone passes fsck", async () => {
    const { server, source } = current;
    const clone = join(tempDir("clone"), "clone");
    await git([...v, "clone", "-q", url(server), clone]);
    await git(["fsck", "--strict", "--full"], { cwd: clone });
    expect(await gitOut(["rev-parse", "HEAD"], { cwd: clone })).toBe(
      await gitOut(["rev-parse", "main"], { cwd: source }),
    );
    expect(await gitOut(["rev-parse", "origin/feature", "v1", "light"], { cwd: clone })).toBe(
      await gitOut(["rev-parse", "feature", "v1", "light"], { cwd: source }),
    );
    expect(await allObjects(clone)).toBe(await allObjects(source));
    expect(server.requests.every((request) => request.version === version)).toBe(true);
  });

  it("clones by walking history when no stored pack can be sent as it is", async () => {
    const { backend, server, source } = current;
    backend.serveStoredPack = false;
    const clone = join(tempDir("clone"), "clone");
    await git([...v, "clone", "-q", url(server), clone]);
    await git(["fsck", "--strict", "--full"], { cwd: clone });
    expect(await allObjects(clone)).toBe(await allObjects(source));
    expect(server.requests.some((request) => request.stats.packSource === "rebuilt")).toBe(true);
  });

  it("makes a shallow clone, deepens it and unshallows it", async () => {
    const { server, source, commits } = current;
    const clone = join(tempDir("shallow"), "clone");
    await git([...v, "clone", "-q", "--depth", "1", url(server), clone]);
    await git(["fsck", "--strict"], { cwd: clone });
    const head = await gitOut(["rev-parse", "main"], { cwd: source });
    expect(await gitOut(["rev-list", "HEAD"], { cwd: clone })).toBe(head);
    expect(await gitOut(["rev-parse", "--is-shallow-repository"], { cwd: clone })).toBe("true");

    await git([...v, "fetch", "-q", "--deepen", "1"], { cwd: clone });
    await git(["fsck", "--strict"], { cwd: clone });
    // The merge's two parents are one step further.
    expect((await gitOut(["rev-list", "HEAD"], { cwd: clone })).split("\n")).toHaveLength(3);

    await git([...v, "fetch", "-q", "--unshallow"], { cwd: clone });
    await git(["fsck", "--strict"], { cwd: clone });
    expect(await gitOut(["rev-parse", "--is-shallow-repository"], { cwd: clone })).toBe("false");
    expect((await gitOut(["rev-list", "HEAD"], { cwd: clone })).split("\n").sort()).toEqual(
      [...commits].sort(),
    );
  });

  it("makes a shallow clone by date and by excluded ref", async () => {
    const { server, source, commits } = current;
    const since = join(tempDir("since"), "clone");
    // c4 was committed at this time; c4, c5, the feature commit and the merge are at or after it.
    const stamp = await gitOut(["log", "-1", "--format=%ct", commits[4]!], { cwd: source });
    await git([
      ...v,
      "clone",
      "-q",
      `--shallow-since=${stamp}`,
      "--single-branch",
      url(server),
      since,
    ]);
    await git(["fsck", "--strict"], { cwd: since });
    const got = (await gitOut(["rev-list", "HEAD"], { cwd: since })).split("\n").sort();
    expect(got).toEqual([commits[4]!, commits[5]!, commits[6]!, commits[7]!].sort());

    const exclude = join(tempDir("exclude"), "clone");
    await git([
      ...v,
      "clone",
      "-q",
      "--shallow-exclude=v1",
      "--single-branch",
      url(server),
      exclude,
    ]);
    await git(["fsck", "--strict"], { cwd: exclude });
    const kept = (await gitOut(["rev-list", "HEAD"], { cwd: exclude })).split("\n").sort();
    // Everything not reachable from v1 (c3): c4, c5, the feature commit and the merge.
    expect(kept).toEqual([commits[4]!, commits[5]!, commits[6]!, commits[7]!].sort());
  });

  it("fetches only what is new when the client has history", async () => {
    const { backend, server, source } = current;
    backend.serveStoredPack = false;
    const clone = join(tempDir("fetch"), "clone");
    await git([...v, "clone", "-q", url(server), clone]);
    // The clone gets commits of its own, so its haves include ids the server has never seen.
    await commitFile(clone, "local.txt", "local\n", "local only");
    const next = await commitFile(source, "dir/file-0.txt", "changed\n".repeat(60), "after clone");
    await git(["push", "-q", "origin", "main"], { cwd: source });
    server.requests.length = 0;

    await git([...v, "fetch", "-q", "origin"], { cwd: clone });
    await git(["fsck", "--strict"], { cwd: clone });
    expect(await gitOut(["rev-parse", "origin/main"], { cwd: clone })).toBe(next);
    const sent = server.requests.reduce((sum, request) => sum + request.stats.objectsSent, 0);
    // One commit, two trees (root and dir) and one blob.
    expect(sent).toBe(4);
  });

  it("sends a shallow clone only what changed when it fetches the next commit", async () => {
    // What a CI runner does: one commit at depth 1, then the next one by id into the same cache.
    const { server, source } = current;
    const clone = join(tempDir("ci"), "clone");
    await git([...v, "clone", "-q", "--depth", "1", url(server), clone]);
    const next = await commitFile(source, "dir/file-0.txt", "changed\n".repeat(60), "after clone");
    const after = await commitFile(source, "dir/file-1.txt", "again\n".repeat(60), "and again");
    await git(["push", "-q", "origin", "main"], { cwd: source });
    server.requests.length = 0;

    await git([...v, "fetch", "-q", "--depth", "1", "origin", next], { cwd: clone });
    await git(["fsck", "--strict"], { cwd: clone });
    expect(await gitOut(["rev-parse", "FETCH_HEAD^{tree}"], { cwd: clone })).toBe(
      await gitOut(["rev-parse", `${next}^{tree}`], { cwd: source }),
    );
    let sent = server.requests.reduce((sum, request) => sum + request.stats.objectsSent, 0);
    // One commit, two trees (root and dir) and one blob: not every file of the commit again.
    expect(sent).toBe(4);

    // And once more, from a clone whose shallow commits are now two. A runner keeps a ref on
    // each commit it fetched, which is what makes the client name it as one it has.
    await git(["update-ref", "refs/ci/c/1", "FETCH_HEAD"], { cwd: clone });
    server.requests.length = 0;
    await git([...v, "fetch", "-q", "--depth", "1", "origin", after], { cwd: clone });
    await git(["fsck", "--strict"], { cwd: clone });
    await git(["checkout", "-q", "FETCH_HEAD"], { cwd: clone });
    expect(await gitOut(["status", "--porcelain"], { cwd: clone })).toBe("");
    sent = server.requests.reduce((sum, request) => sum + request.stats.objectsSent, 0);
    expect(sent).toBe(4);
  });

  it("fetches a commit by id that is no longer a tip", async () => {
    const { server, commits } = current;
    const repo = await initRepo("by-id");
    await git([...v, "fetch", "-q", "--depth", "1", url(server), commits[4]!], { cwd: repo });
    expect(await gitOut(["rev-parse", "FETCH_HEAD"], { cwd: repo })).toBe(commits[4]!);
    await git(["fsck", "--strict"], { cwd: repo });
  });

  it("refuses an id that no ref reaches", async () => {
    const { server } = current;
    const repo = await initRepo("bogus");
    const result = await git(
      [...v, "fetch", "-q", url(server), "1234567890123456789012345678901234567890"],
      { cwd: repo, allowFailure: true },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not our ref/);
  });

  it("lists refs with ls-remote, peeled tags and the HEAD symref included", async () => {
    const { server, source } = current;
    const listed = await gitOut([...v, "ls-remote", "--symref", url(server)]);
    expect(listed).toContain("ref: refs/heads/main\tHEAD");
    const v1 = await gitOut(["rev-parse", "v1^{}"], { cwd: source });
    expect(listed).toContain(`${v1}\trefs/tags/v1^{}`);
    expect(listed).toContain("refs/heads/feature");
  });

  it("clones an empty repository", async () => {
    const backend = new MemoryBackend();
    const server = await startServer(backend);
    try {
      const clone = join(tempDir("empty"), "clone");
      const result = await git([...v, "clone", url(server), clone]);
      expect(result.stderr).toMatch(/empty repository/);
      expect(server.errors).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describeGit.each([
  { name: "http", url: (s: TestServer) => s.httpUrl },
  { name: "stream", url: (s: TestServer) => s.streamUrl },
])("push over $name", ({ url }) => {
  /** A second clone to push from, so the server's refs are what it starts with. */
  async function workTree(): Promise<string> {
    const clone = join(tempDir("push"), "clone");
    await git(["clone", "-q", url(current.server), clone]);
    return clone;
  }

  it("creates, updates, force-updates and deletes branches and tags", async () => {
    const { backend } = current;
    const work = await workTree();
    const next = await commitFile(work, "new.txt", "new\n", "new commit");
    await git(["push", "-q", "origin", "main", "main:refs/heads/created"], { cwd: work });
    expect(backend.refs.get("refs/heads/main")).toBe(next);
    expect(backend.refs.get("refs/heads/created")).toBe(next);

    // Rewind and diverge: only a forced push may land it.
    await git(["reset", "-q", "--hard", "HEAD~2"], { cwd: work });
    const rewritten = await commitFile(work, "other.txt", "other\n", "rewritten");
    const refused = await git(["push", "origin", "main"], { cwd: work, allowFailure: true });
    expect(refused.status).not.toBe(0);
    expect(backend.refs.get("refs/heads/main")).toBe(next);
    await git(["push", "-q", "--force", "origin", "main"], { cwd: work });
    expect(backend.refs.get("refs/heads/main")).toBe(rewritten);

    await git(["tag", "-a", "-m", "two", "v2"], { cwd: work });
    await git(["push", "-q", "origin", "v2"], { cwd: work });
    expect(backend.refs.has("refs/tags/v2")).toBe(true);

    await git(["push", "-q", "origin", "--delete", "created", "v2"], { cwd: work });
    expect(backend.refs.has("refs/heads/created")).toBe(false);
    expect(backend.refs.has("refs/tags/v2")).toBe(false);

    const verify = join(tempDir("verify"), "clone");
    await git(["clone", "-q", url(current.server), verify]);
    await git(["fsck", "--strict", "--full"], { cwd: verify });
    expect(await gitOut(["rev-parse", "HEAD"], { cwd: verify })).toBe(rewritten);
  });

  it("refuses to delete the branch HEAD names", async () => {
    const work = await workTree();
    const result = await git(["push", "origin", "--delete", "main"], {
      cwd: work,
      allowFailure: true,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/deletion of the current branch prohibited/);
    expect(current.backend.refs.has("refs/heads/main")).toBe(true);
  });

  it("applies an atomic push entirely or not at all", async () => {
    const { backend, server } = current;
    const work = await workTree();
    const before = backend.refs.get("refs/heads/main");
    await commitFile(work, "atomic.txt", "atomic\n", "atomic");
    server.hooks = {
      check: async (updates) =>
        new Map(
          updates
            .filter((update) => update.name === "refs/heads/blocked")
            .map((update) => [update.name, "this branch is blocked"]),
        ),
      after: async () => undefined,
    };
    const result = await git(["push", "--atomic", "origin", "main", "main:refs/heads/blocked"], {
      cwd: work,
      allowFailure: true,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/this branch is blocked/);
    expect(backend.refs.get("refs/heads/main")).toBe(before);
    expect(backend.refs.has("refs/heads/blocked")).toBe(false);

    // Without --atomic the allowed ref moves and the blocked one does not.
    const partial = await git(["push", "origin", "main", "main:refs/heads/blocked"], {
      cwd: work,
      allowFailure: true,
    });
    expect(partial.status).not.toBe(0);
    expect(backend.refs.get("refs/heads/main")).not.toBe(before);
    expect(backend.refs.has("refs/heads/blocked")).toBe(false);
  });

  it("tells the hooks what kind of change each update is, and passes push options", async () => {
    const { server } = current;
    const work = await workTree();
    const checked: ReceiveUpdate[] = [];
    const after: ReceiveUpdate[] = [];
    let options: readonly string[] = [];
    server.hooks = {
      check: async (updates, context) => {
        checked.push(...updates);
        options = context.pushOptions;
        return new Map();
      },
      after: async (applied) => {
        after.push(...applied);
      },
    };
    await commitFile(work, "ff.txt", "ff\n", "fast-forward");
    await git(
      [
        "push",
        "-q",
        "-o",
        "ci.skip",
        "-o",
        "note=hello",
        "origin",
        "main",
        "main:refs/heads/fresh",
      ],
      {
        cwd: work,
      },
    );
    expect(options).toEqual(["ci.skip", "note=hello"]);
    const summary = (updates: ReceiveUpdate[]): unknown[] =>
      updates.map((update) => [update.name, update.kind, update.forced]).sort();
    expect(summary(checked)).toEqual([
      ["refs/heads/fresh", "create", false],
      ["refs/heads/main", "update", false],
    ]);
    expect(after).toEqual(checked);

    checked.length = 0;
    await git(["reset", "-q", "--hard", "HEAD~1"], { cwd: work });
    await commitFile(work, "diverged.txt", "x\n", "diverged");
    await git(["push", "-q", "--force", "origin", "main", ":fresh"], { cwd: work });
    expect(summary(checked)).toEqual([
      ["refs/heads/fresh", "delete", false],
      ["refs/heads/main", "update", true],
    ]);
  });

  it("takes a first push into an empty repository", async () => {
    const backend = new MemoryBackend();
    const server = await startServer(backend);
    try {
      const work = await initRepo("first-push");
      const head = await commitFile(work, "README.md", "# hello\n", "first");
      await git(["push", "-q", url(server), "main"], { cwd: work });
      expect(backend.refs.get("refs/heads/main")).toBe(head);
      const clone = join(tempDir("first-clone"), "clone");
      await git(["clone", "-q", url(server), clone]);
      expect(await gitOut(["rev-parse", "HEAD"], { cwd: clone })).toBe(head);
      expect(server.errors).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("refuses a pack that leaves out an object it needs", async () => {
    const { backend, server } = current;
    const work = await workTree();
    await commitFile(work, "needed.txt", "needed\n", "needs a blob");
    // Drop the new blob from the client's store: it now pushes a tree that names a missing object.
    const blob = await gitOut(["rev-parse", "HEAD:needed.txt"], { cwd: work });
    const { rmSync } = await import("node:fs");
    rmSync(join(work, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    const before = backend.refs.get("refs/heads/main");
    const packs = backend.packs.length;
    const result = await git(["push", "origin", "main"], { cwd: work, allowFailure: true });
    expect(result.status).not.toBe(0);
    expect(backend.refs.get("refs/heads/main")).toBe(before);
    expect(backend.packs.length).toBe(packs);
    expect(server.errors).toEqual([]);
  });
});

describeGit.each([
  { name: "http", url: (s: TestServer) => s.httpUrl, whole: true },
  { name: "stream", url: (s: TestServer) => s.streamUrl, whole: false },
])("a push the server takes a while to store, over $name", ({ url, whole }) => {
  it("keeps the connection alive with empty packets, which git accepts", async () => {
    const inner = new MemoryBackend();
    const arrivals: boolean[] = [];
    let keepalivesDue = 0;
    // Stores the pack, says it is in, then takes ten keepalive periods more.
    const slow = Object.create(inner) as RepositoryBackend & { ingestPack: unknown };
    slow.ingestPack = async (
      pack: ReadableStream<Uint8Array>,
      options?: { readonly whole: boolean; readonly onReceived: () => void },
    ) => {
      const ingested = await inner.ingestPack(pack);
      arrivals.push(options?.whole ?? false);
      options?.onReceived();
      keepalivesDue = 10;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return ingested;
    };
    const server = await startServer(slow, { limits: { keepAliveMs: 20 } });
    try {
      const source = await initRepo("slow-push");
      const head = await commitFile(source, "a.txt", "a\n", "first");
      const result = await git(["push", url(server), "main"], {
        cwd: source,
        env: { GIT_TRACE_PACKET: "1" },
      });
      expect(result.status).toBe(0);
      // The empty data-band packets arrived before the report: git traces each as `\1`.
      const keepalives = result.stderr
        .split("\n")
        .filter((line) => /(sideband|push)< \\1$/.test(line) || /packet: +\w+< \\1$/.test(line));
      expect(keepalives.length).toBeGreaterThanOrEqual(3);
      expect(inner.refs.get("refs/heads/main")).toBe(head);
      expect(arrivals).toEqual([whole]);
      expect(keepalivesDue).toBe(10);
      expect(server.errors).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
