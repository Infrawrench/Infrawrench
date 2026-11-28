/**
 * The JSON API's reader against a real history, with `git` as the judge:
 * what it lists, diffs, blames and merges has to be what `git` says of the
 * same repository. The reader runs as it does in the Durable Object
 * (`src/repo/queries`), on the Node stand-ins for R2 and SQLite, and the
 * history reaches it the way any history does: pushed by the real `git`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BLOB_TEXT_LIMIT_BYTES, rawPath } from "@infrawrench/git-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_READER_LIMITS,
  ReaderState,
  callReader,
  localRepoReader,
} from "../src/repo/queries";
import { durableRepoReader } from "../src/repo/reader-do";
import { type RepoReader, RepoReaderError } from "../src/repo/reader";
import {
  cleanupTempDirs,
  commitFile,
  git,
  gitOut,
  hasGit,
  initRepo,
  resetClock,
  tempDir,
} from "./support/git";
import { MemoryBucket } from "./support/node-platform";
import { type NodeRepo, peerOf, startNodeRepo } from "./support/node-server";

afterAll(cleanupTempDirs);

const describeGit = describe.skipIf(!hasGit);
const ACTOR = { kind: "user" as const, userId: "user-7", credentialId: null };
const MERGER = { name: "Mo Merger", email: "mo@example.com" };

const lines = (count: number, changed: Record<number, string> = {}): string =>
  Array.from({ length: count }, (_, i) => changed[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

/** Several repositories that can reach each other, as Durable Objects do through their stubs. */
class Hub {
  readonly bucket = new MemoryBucket();
  readonly repos = new Map<string, NodeRepo>();

  async open(id: string): Promise<NodeRepo> {
    const repo = await startNodeRepo(id, {
      bucket: this.bucket,
      peer: (other) => peerOf(this.repos.get(other)!.repository),
    });
    this.repos.set(id, repo);
    return repo;
  }

  reader(id: string, name = "fixture"): RepoReader {
    return localRepoReader(this.repos.get(id)!.repository, new ReaderState(), {
      id,
      owner: "acme",
      name,
    });
  }

  async close(): Promise<void> {
    for (const repo of this.repos.values()) {
      expect(repo.errors).toEqual([]);
      await repo.close();
    }
  }
}

interface Fixture {
  readonly work: string;
  /** Commit ids by the names used below. */
  readonly at: Record<string, string>;
}

/**
 * A history with what a forge meets: edits, a rename, a binary file, a file
 * over the text limit, a side branch merged back, tags of both kinds, a
 * branch that conflicts with `main` and one that merges cleanly.
 */
async function buildFixture(): Promise<Fixture> {
  resetClock();
  const work = await initRepo("reader");
  const at: Record<string, string> = {};
  const checkout = (...args: string[]) => git(["checkout", "-q", ...args], { cwd: work });

  await commitFile(work, "docs/guide.md", "# Guide\n\nRead me first.\n", "docs: start a guide");
  await commitFile(work, "src/b.txt", lines(30), "add b");
  at.c1 = await commitFile(work, "src/a.txt", lines(20), "add a");
  await commitFile(work, "README.md", "# Fixture\n\nhello\n", "add a readme");
  at.c2 = await commitFile(work, "src/a.txt", lines(20, { 5: "five" }), "a: change line 5");
  await git(["tag", "v1"], { cwd: work });

  await checkout("-b", "feature");
  await commitFile(work, "src/a.txt", lines(20, { 5: "five", 15: "fifteen" }), "a: line 15");
  at.f2 = await commitFile(
    work,
    "src/feature.txt",
    "a feature\n",
    "add the feature\n\nWith a body.",
  );

  await checkout("main");
  const binary = new Uint8Array(4096);
  for (let i = 0; i < binary.length; i++) binary[i] = i % 7 === 0 ? 0 : (i * 31) & 0xff;
  await commitFile(work, "bin/data.bin", binary, "add a binary file");
  at.big = await commitFile(work, "big.txt", "0123456789abcdef\n".repeat(70_000), "add a big file");
  await git(["mv", "src/b.txt", "src/c.txt"], { cwd: work });
  at.rename = await commitFile(work, "src/c.txt", lines(30, { 30: "thirty" }), "rename b to c");
  await commitFile(work, "src/a.txt", lines(20, { 2: "two", 5: "five" }), "a: change line 2");
  // Dated between the commit before it and the one after, so history stays in date order.
  const before = Number(await gitOut(["log", "-1", "--format=%ct"], { cwd: work }));
  await git(["merge", "-q", "--no-ff", "feature", "-m", "Merge branch 'feature'"], {
    cwd: work,
    env: {
      GIT_AUTHOR_DATE: `${before + 20} +0000`,
      GIT_COMMITTER_DATE: `${before + 20} +0000`,
    },
  });
  at.merge = await gitOut(["rev-parse", "HEAD"], { cwd: work });
  await git(["tag", "-a", "v2", "-m", "Second release"], {
    cwd: work,
    env: { GIT_COMMITTER_DATE: `${before + 30} +0000` },
  });
  at.c6 = await commitFile(work, "README.md", "# Fixture\n\nhello again\n", "readme: again");

  await checkout("-b", "conflict");
  at.conflict = await commitFile(
    work,
    "src/a.txt",
    lines(20, { 2: "deux", 5: "five", 15: "fifteen" }),
    "a: line 2, another way",
  );

  await checkout("main");
  at.c7 = await commitFile(
    work,
    "src/a.txt",
    lines(20, { 2: "TWO", 5: "five", 15: "fifteen" }),
    "a: line 2 in capitals",
  );

  await checkout("-b", "topic");
  await commitFile(work, "t1.txt", "one\n", "topic: one");
  await commitFile(work, "src/c.txt", lines(30, { 1: "first", 30: "thirty" }), "topic: edit c");
  at.topic = await commitFile(work, "dir/t3.txt", "three\n", "topic: three");

  await checkout("main");
  at.main = await commitFile(
    work,
    "docs/guide.md",
    "# Guide\n\nRead me first.\n\nMore.\n",
    "docs: more",
  );
  return { work, at };
}

describeGit("the reader, with git as the judge", () => {
  let fixture: Fixture;
  let hub: Hub;
  let reader: RepoReader;
  let work: string;

  /** A new repository holding the fixture, for a test that changes it. */
  const fresh = async (id: string, inHub: Hub = hub): Promise<NodeRepo> => {
    const repo = await inHub.open(id);
    await git(["push", "-q", repo.url, "--all"], { cwd: work });
    await git(["push", "-q", repo.url, "--tags"], { cwd: work });
    return repo;
  };

  /** A clone of the fixture to ask `git` what a merge should give. */
  const scratch = async (): Promise<string> => {
    const dir = join(tempDir("oracle"), "repo");
    await git(["clone", "-q", work, dir]);
    for (const branch of ["topic", "conflict", "feature"]) {
      await git(["branch", "-q", branch, `origin/${branch}`], { cwd: dir });
    }
    return dir;
  };

  const treeOf = (dir: string, rev: string) => gitOut(["rev-parse", `${rev}^{tree}`], { cwd: dir });
  const fetched = async (repo: NodeRepo, ref: string): Promise<{ dir: string; oid: string }> => {
    const dir = join(tempDir("fetch"), "repo");
    await git(["clone", "-q", repo.url, dir]);
    await git(["fetch", "-q", "origin", ref], { cwd: dir });
    await git(["fsck", "--strict", "--full"], { cwd: dir });
    return { dir, oid: await gitOut(["rev-parse", "FETCH_HEAD"], { cwd: dir }) };
  };

  beforeAll(async () => {
    fixture = await buildFixture();
    work = fixture.work;
    hub = new Hub();
    const repo = await hub.open("repo-1");
    await git(["push", "-q", repo.url, "--all"], { cwd: work });
    await git(["push", "-q", repo.url, "--tags"], { cwd: work });
    reader = hub.reader("repo-1");
  });
  afterAll(async () => {
    await hub.close();
  });

  it("keeps its restated constants equal to the contract's", () => {
    expect(DEFAULT_READER_LIMITS.blobTextBytes).toBe(BLOB_TEXT_LIMIT_BYTES);
  });

  it("resolves refs the way the contract says", async () => {
    const { at } = fixture;
    expect(await reader.resolveRef(undefined)).toEqual({
      name: "main",
      kind: "branch",
      fullName: "refs/heads/main",
      commitOid: at.main,
    });
    expect(await reader.resolveRef("v1")).toMatchObject({ kind: "tag", commitOid: at.c2 });
    // An annotated tag is peeled to its commit.
    expect(await reader.resolveRef("refs/tags/v2")).toMatchObject({
      kind: "tag",
      name: "v2",
      commitOid: at.merge,
    });
    expect(await reader.resolveRef(at.c1!.slice(0, 8))).toEqual({
      name: at.c1,
      kind: "commit",
      fullName: null,
      commitOid: at.c1,
    });
    await expect(reader.resolveRef("nope")).rejects.toMatchObject({ code: "ref_not_found" });
    await expect(reader.resolveRef("0".repeat(40))).rejects.toMatchObject({
      code: "ref_not_found",
    });
  });

  it("lists a directory with sizes and the commit that last changed each entry", async () => {
    const listing = await reader.tree({ ref: undefined, path: "", lastCommits: true });
    const names = (await gitOut(["ls-tree", "--name-only", "HEAD"], { cwd: work })).split("\n");
    expect(listing.entries.map((entry) => entry.name).sort()).toEqual([...names].sort());
    // Directories first.
    const kinds = listing.entries.map((entry) => entry.type);
    expect(kinds.lastIndexOf("tree")).toBeLessThan(kinds.indexOf("blob"));
    expect(listing.lastCommitsComplete).toBe(true);
    expect(listing.truncated).toBe(false);
    expect(listing.readmePath).toBe("README.md");
    expect(listing.lastCommit?.oid).toBe(fixture.at.main);
    expect(listing.commitCount).toBe(
      Number(await gitOut(["rev-list", "--count", "HEAD"], { cwd: work })),
    );
    for (const entry of listing.entries) {
      const last = await gitOut(["log", "-1", "--format=%H", "--", entry.path], { cwd: work });
      expect(entry.lastCommit?.oid, entry.path).toBe(last);
      if (entry.type === "blob") {
        const size = Number(await gitOut(["cat-file", "-s", `HEAD:${entry.path}`], { cwd: work }));
        expect(entry.size, entry.path).toBe(size);
      } else {
        expect(entry.size).toBeNull();
      }
    }

    const sub = await reader.tree({ ref: "feature", path: "src/", lastCommits: true });
    expect(sub.path).toBe("src");
    expect(sub.commitCount).toBeNull();
    for (const entry of sub.entries) {
      const last = await gitOut(["log", "-1", "--format=%H", "feature", "--", entry.path], {
        cwd: work,
      });
      expect(entry.lastCommit?.oid, entry.path).toBe(last);
    }
    expect(sub.lastCommit?.oid).toBe(
      await gitOut(["log", "-1", "--format=%H", "feature", "--", "src"], { cwd: work }),
    );

    await expect(
      reader.tree({ ref: undefined, path: "README.md", lastCommits: false }),
    ).rejects.toMatchObject({ code: "not_a_directory" });
    await expect(
      reader.tree({ ref: undefined, path: "missing", lastCommits: false }),
    ).rejects.toMatchObject({ code: "path_not_found" });
  });

  it("fills the last-commit column in steps when the budget is short, and writes it down", async () => {
    const repo = hub.repos.get("repo-1")!.repository;
    const state = new ReaderState();
    const stepped = localRepoReader(
      repo,
      state,
      { id: "repo-1", owner: "acme", name: "fixture" },
      { limits: { treeWalkCommits: 2, lastCommitsCommits: 3 } },
    );
    const first = await stepped.tree({ ref: "topic", path: "", lastCommits: true });
    expect(first.lastCommitsComplete).toBe(false);
    expect(first.entries.some((entry) => entry.lastCommit === null)).toBe(true);
    let rounds = 0;
    let more = await stepped.treeLastCommits({ ref: "topic", path: "" });
    while (!more.complete) {
      expect(++rounds).toBeLessThan(20);
      more = await stepped.treeLastCommits({ ref: "topic", path: "" });
    }
    expect(rounds).toBeGreaterThan(0);
    for (const entry of first.entries) {
      const last = await gitOut(["log", "-1", "--format=%H", "topic", "--", entry.path], {
        cwd: work,
      });
      expect(more.commits[entry.name]?.oid, entry.path).toBe(last);
    }

    // An object that has just woken reads the answer back instead of walking again.
    const woken = localRepoReader(
      repo,
      new ReaderState(),
      { id: "repo-1", owner: "acme", name: "fixture" },
      { limits: { treeWalkCommits: 0 } },
    );
    const again = await woken.tree({ ref: "topic", path: "", lastCommits: true });
    expect(again.lastCommitsComplete).toBe(true);
    expect(again.entries.every((entry) => entry.lastCommit !== null)).toBe(true);
  });

  it("answers a file as text, a binary file and a large file as what they are", async () => {
    const readme = await reader.blob({ ref: undefined, path: "README.md" });
    expect(readme).toMatchObject({
      path: "README.md",
      name: "README.md",
      mode: "100644",
      binary: false,
      truncated: false,
      text: "# Fixture\n\nhello again\n",
      lineCount: 3,
      lfs: null,
      size: 23,
    });
    expect(readme.oid).toBe(await gitOut(["rev-parse", "HEAD:README.md"], { cwd: work }));
    expect(readme.lastCommit?.oid).toBe(fixture.at.c6);
    expect(readme.rawUrl).toBe(
      rawPath({ owner: "acme", repo: "fixture" }, fixture.at.main!, "README.md"),
    );
    // An older ref answers the older file.
    expect((await reader.blob({ ref: "v1", path: "README.md" })).text).toBe("# Fixture\n\nhello\n");

    const binary = await reader.blob({ ref: undefined, path: "bin/data.bin" });
    expect(binary).toMatchObject({ binary: true, text: null, size: 4096, lineCount: null });
    const big = await reader.blob({ ref: undefined, path: "big.txt" });
    expect(big).toMatchObject({ binary: false, truncated: true, text: null });
    expect(big.size).toBe(17 * 70_000);

    await expect(reader.blob({ ref: undefined, path: "src" })).rejects.toMatchObject({
      code: "not_a_file",
    });
    await expect(reader.blob({ ref: undefined, path: "src/nope" })).rejects.toMatchObject({
      code: "path_not_found",
    });

    const found = await reader.readme({ ref: undefined, path: "" });
    expect(found?.path).toBe("README.md");
    expect(found?.text).toBe(readme.text);
    expect(await reader.readme({ ref: undefined, path: "src" })).toBeNull();
  });

  it("answers a file without walking history when asked, and the walk on its own", async () => {
    const bare = await reader.blob({ ref: undefined, path: "README.md", lastCommit: false });
    expect(bare.lastCommit).toBeNull();
    expect(bare.text).toBe("# Fixture\n\nhello again\n");
    const full = await reader.blob({ ref: undefined, path: "README.md" });
    const changed = await gitOut(["log", "-1", "--format=%H", "--", "README.md"], { cwd: work });
    expect(full.lastCommit?.oid).toBe(changed);

    const latest = await reader.latestCommit({ ref: undefined, path: "README.md" });
    expect(latest).toMatchObject({ commit: { oid: changed }, count: null });
    const root = await reader.latestCommit({ ref: undefined, path: "" });
    expect(root.commit?.oid).toBe(fixture.at.main);
    expect(root.count).toBe(Number(await gitOut(["rev-list", "--count", "main"], { cwd: work })));
  });

  it("counts the bytes of each language, leaving out vendored, docs, minified and prose", async () => {
    const dir = join(tempDir("languages"), "repo");
    await git(["init", "-q", "-b", "main", dir]);
    const put = (path: string, bytes: number) => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), "x".repeat(bytes));
    };
    put("src/app.ts", 300);
    put("src/view.tsx", 200);
    put("src/util.js", 100);
    put("Dockerfile", 40);
    put("infra/main.tf", 60);
    put("README.md", 5000);
    put("data/config.json", 5000);
    put("vendor/lib.js", 5000);
    put("node_modules/pkg/index.js", 5000);
    put("docs/example.ts", 5000);
    put("public/app.min.js", 5000);
    await git(["add", "-A"], { cwd: dir });
    await git(
      ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "files"],
      {
        cwd: dir,
      },
    );
    const repo = await hub.open("repo-languages");
    await git(["push", "-q", repo.url, "main"], { cwd: dir });
    const measured = await hub.reader("repo-languages").languages({ ref: undefined });
    expect(measured.commitOid).toBe(await gitOut(["rev-parse", "HEAD"], { cwd: dir }));
    expect(measured.truncated).toBe(false);
    expect(measured.languages).toEqual([
      { name: "TypeScript", bytes: 500 },
      { name: "JavaScript", bytes: 100 },
      { name: "HCL", bytes: 60 },
      { name: "Dockerfile", bytes: 40 },
    ]);
  });

  it("reads every Terraform file of a commit in one walk, and a tree once", async () => {
    const dir = join(tempDir("terraform-files"), "repo");
    await git(["init", "-q", "-b", "main", dir]);
    const put = (path: string, text: string | Buffer) => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    put("envs/prod/main.tf", 'module "net" {\n  source = "../../modules/net"\n}\n');
    put("envs/prod/terraform.tfvars", 'region = "eu-west-1"\n');
    put("envs/prod/.terraform.lock.hcl", "# locks\n");
    put("modules/net/main.tf.json", '{"resource": {}}\n');
    put("modules/net/README.md", "# net\n");
    put("envs/prod/.terraform/providers/x.tf", "skipped\n");
    put("node_modules/pkg/main.tf", "skipped\n");
    put("binary.tf", Buffer.from([0, 1, 2, 255, 254]));
    await git(["add", "-A", "-f"], { cwd: dir });
    await git(["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "tf"], {
      cwd: dir,
    });
    const repo = await hub.open("repo-terraform");
    await git(["push", "-q", repo.url, "main"], { cwd: dir });
    const reader = hub.reader("repo-terraform");
    const read = await reader.terraformFiles({ ref: undefined });
    expect(read.commitOid).toBe(await gitOut(["rev-parse", "HEAD"], { cwd: dir }));
    expect(read.treeOid).toBe(await gitOut(["rev-parse", "HEAD^{tree}"], { cwd: dir }));
    expect(read.snapshot.truncated).toBe(false);
    expect(read.snapshot.files.map((file) => [file.path, file.text !== null])).toEqual([
      ["binary.tf", false],
      ["envs/prod/.terraform.lock.hcl", true],
      ["envs/prod/main.tf", true],
      ["envs/prod/terraform.tfvars", true],
      ["modules/net/main.tf.json", true],
    ]);
    // ci-reads-ignore: a Terraform source in the fixture's text, not a file this test reads
    expect(read.snapshot.files[2]!.text).toContain("../../modules/net");
    // The same tree again is answered from the object's memory, with the commit asked about.
    const again = await reader.terraformFiles({ ref: read.commitOid });
    expect(again).toEqual(read);
  });

  it("restates the contract's raw URL for names that need encoding", async () => {
    const odd = await hub.open("repo-odd");
    const dir = await initRepo("odd");
    const oid = await commitFile(dir, "a dir/file #1?.txt", "x\n", "odd names");
    await git(["push", "-q", odd.url, "main"], { cwd: dir });
    const blob = await hub
      .reader("repo-odd", "my repo")
      .blob({ ref: undefined, path: "a dir/file #1?.txt" });
    expect(blob.rawUrl).toBe(
      rawPath({ owner: "acme", repo: "my repo" }, oid, "a dir/file #1?.txt"),
    );
  });

  it("lists history like git log: whole, by path, by author and date, in pages", async () => {
    const all = (await gitOut(["log", "--format=%H"], { cwd: work })).split("\n");
    const paged: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await reader.listCommits({ ref: undefined, limit: 4, cursor });
      paged.push(...page.items.map((commit) => commit.oid));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor !== undefined);
    expect(paged).toEqual(all);
    expect(pages).toBe(Math.ceil(all.length / 4));

    for (const path of ["src/a.txt", "src", "docs/guide.md", "README.md"]) {
      const expected = (await gitOut(["log", "--format=%H", "--", path], { cwd: work })).split(
        "\n",
      );
      const got: string[] = [];
      let at: string | undefined;
      do {
        const page = await reader.listCommits({ ref: undefined, limit: 3, cursor: at, path });
        got.push(...page.items.map((commit) => commit.oid));
        at = page.nextCursor ?? undefined;
      } while (at !== undefined);
      expect(got, path).toEqual(expected);
    }

    // A renamed file's history carries on under its old name when asked to follow.
    const followed = await reader.listCommits({
      ref: undefined,
      limit: 50,
      path: "src/c.txt",
      follow: true,
    });
    expect(followed.items.map((commit) => commit.oid)).toEqual(
      (await gitOut(["log", "--follow", "--format=%H", "--", "src/c.txt"], { cwd: work })).split(
        "\n",
      ),
    );

    const first = await reader.listCommits({ ref: undefined, limit: 1 });
    expect(first.items[0]).toMatchObject({
      oid: fixture.at.main,
      summary: "docs: more",
      hasBody: false,
      author: { name: "Ada Author", email: "ada@example.com", timezoneOffset: 0 },
      committer: { name: "Cy Committer", email: "cy@example.com" },
      authorUser: null,
      status: null,
    });
    const withBody = await reader.commits([fixture.at.f2!, "f".repeat(40)]);
    expect(withBody).toHaveLength(1);
    expect(withBody[0]).toMatchObject({ summary: "add the feature", hasBody: true });

    expect(
      (await reader.listCommits({ ref: undefined, limit: 50, authorEmails: ["nobody@x"] })).items,
    ).toEqual([]);
    expect(
      (await reader.listCommits({ ref: undefined, limit: 50, authorEmails: ["ADA@example.com"] }))
        .items,
    ).toHaveLength(all.length);
    const since = "2023-11-14T22:20:00Z";
    const expected = (
      await gitOut(["log", "--format=%H", `--since=${since}`], { cwd: work })
    ).split("\n");
    expect(
      (await reader.listCommits({ ref: undefined, limit: 50, since })).items.map((c) => c.oid),
    ).toEqual(expected.filter((oid) => oid !== ""));
  });

  it("shows a commit and its diff as git does", async () => {
    for (const name of ["c2", "rename", "merge", "main", "big"]) {
      const oid = fixture.at[name]!;
      const detail = await reader.commit(oid.slice(0, 10));
      expect(detail.commit.oid).toBe(oid);
      expect(detail.commit.treeOid).toBe(await treeOf(work, oid));
      expect(detail.commit.message).toBe(
        `${await gitOut(["log", "-1", "--format=%B", oid], { cwd: work })}\n`,
      );
      // Against the first parent, as a commit page shows a merge.
      const numstat = (
        await gitOut(["diff", "--numstat", "-M", `${oid}^`, oid], { cwd: work })
      ).split("\n");
      expect(detail.files).toHaveLength(numstat.length);
      expect(detail.filesTruncated).toBe(false);
      let additions = 0;
      let deletions = 0;
      for (const file of detail.files) {
        const row = numstat.find((line) => line.endsWith(`\t${file.path}`) || line.includes(`=> `));
        expect(row, file.path).toBeDefined();
        if (!file.binary && !row!.startsWith("-")) {
          const [added, removed] = row!.split("\t").map(Number);
          // A file over the text limit is listed without counts.
          if (file.path !== "big.txt") {
            expect([file.additions, file.deletions], file.path).toEqual([added, removed]);
          }
        }
        additions += file.additions;
        deletions += file.deletions;
      }
      expect(detail.stats).toEqual({ filesChanged: numstat.length, additions, deletions });
    }

    const renamed = await reader.commit(fixture.at.rename!);
    expect(renamed.files[0]).toMatchObject({
      path: "src/c.txt",
      oldPath: "src/b.txt",
      status: "renamed",
      additions: 1,
      deletions: 1,
    });
    expect(renamed.files[0]!.similarity).toBeGreaterThan(90);
    expect((await reader.commit(fixture.at.c2!)).tags).toEqual(["v1"]);
    expect((await reader.commit(fixture.at.merge!)).tags).toEqual(["v2"]);
    expect((await reader.commit(fixture.at.main!)).branches).toEqual(["main"]);

    // The hunks, written back out as a patch, are git's patch.
    const oid = fixture.at.c7!;
    const diff = await reader.commitDiff(oid, { limit: 30 });
    expect(diff.baseOid).toBe(await gitOut(["rev-parse", `${oid}^`], { cwd: work }));
    expect(diff.headOid).toBe(oid);
    expect(diff.nextCursor).toBeNull();
    const patch = diff.files[0]!.hunks.map((hunk) =>
      [
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${
          hunk.section === "" ? "" : ` ${hunk.section}`
        }`,
        ...hunk.lines.map(
          (line) => (line.type === "add" ? "+" : line.type === "delete" ? "-" : " ") + line.content,
        ),
      ].join("\n"),
    ).join("\n");
    const expected = await gitOut(["diff", `${oid}^`, oid, "--", "src/a.txt"], { cwd: work });
    expect(patch).toBe(expected.slice(expected.indexOf("@@")));

    // The too-large file says so; the binary one has no hunks.
    const big = await reader.commitDiff(fixture.at.big!, { limit: 30 });
    expect(big.files[0]).toMatchObject({ path: "big.txt", tooLarge: true, hunks: [] });
    // One file a page, in path order, with the whole diff's stats on each.
    const merge = fixture.at.merge!;
    const one = await reader.commitDiff(merge, { limit: 1 });
    expect(one.files).toHaveLength(1);
    expect(one.nextCursor).not.toBeNull();
    const two = await reader.commitDiff(merge, { limit: 1, cursor: one.nextCursor! });
    expect(two.files[0]!.path).not.toBe(one.files[0]!.path);
    expect(two.stats).toEqual(one.stats);
    const only = await reader.commitDiff(merge, { limit: 30, path: "src/feature.txt" });
    expect(only.files.map((file) => file.path)).toEqual(["src/feature.txt"]);

    await expect(reader.commit("abcd1234")).rejects.toMatchObject({ code: "ref_not_found" });
  });

  it("compares across a merge: merge base, ahead and behind, commits and files", async () => {
    for (const [base, head] of [
      ["v1", "main"],
      ["main", "topic"],
      ["feature", "conflict"],
      ["topic", "main"],
    ] as const) {
      const comparison = await reader.compare({ base, head });
      expect(comparison.mergeBaseOid, `${base}...${head}`).toBe(
        await gitOut(["merge-base", base, head], { cwd: work }),
      );
      const [behind, ahead] = (
        await gitOut(["rev-list", "--left-right", "--count", `${base}...${head}`], { cwd: work })
      )
        .split("\t")
        .map(Number);
      expect([comparison.ahead, comparison.behind]).toEqual([ahead, behind]);
      const expected = (
        await gitOut(["log", "--reverse", "--format=%H", `${base}..${head}`], { cwd: work })
      )
        .split("\n")
        .filter((oid) => oid !== "");
      expect([...comparison.commits.map((commit) => commit.oid)].sort()).toEqual(
        [...expected].sort(),
      );
      const names = (
        await gitOut(["diff", "--name-only", "-M", `${base}...${head}`], { cwd: work })
      )
        .split("\n")
        .filter((name) => name !== "");
      expect(comparison.files.map((file) => file.path).sort()).toEqual(names.sort());

      const between = await reader.commitsBetween({ base, head }, { limit: 100 });
      expect(between.items.map((commit) => commit.oid)).toEqual(
        comparison.commits.map((commit) => commit.oid),
      );
      const diff = await reader.compareDiff({ base, head }, { limit: 100 });
      expect(diff.baseOid).toBe(comparison.mergeBaseOid);
      expect(diff.stats).toEqual(comparison.stats);
    }
    expect((await reader.compare({ base: "main", head: "topic" })).mergeable).toBe(true);
    expect((await reader.compare({ base: "main", head: "conflict" })).mergeable).toBe(false);
    expect((await reader.compare({ base: "main", head: "v1" })).mergeable).toBeNull();
    await expect(reader.compare({ base: "main", head: "nope" })).rejects.toMatchObject({
      code: "ref_not_found",
    });
  });

  it("says what a push added, for a moved branch and for a new one", async () => {
    const { at } = fixture;
    const moved = await reader.commitRange({ base: at.c7!, head: at.main!, limit: 10 });
    expect(moved.map((commit) => commit.oid)).toEqual([at.main]);
    expect(moved[0]!.message).toBe("docs: more\n");
    // A new branch: what no other branch has.
    const created = await reader.commitRange({ base: null, head: at.topic!, limit: 10 });
    expect(created.map((commit) => commit.oid)).toEqual(
      (await gitOut(["log", "--reverse", "--format=%H", "main..topic"], { cwd: work })).split("\n"),
    );
    // Capped at the newest.
    expect(
      (await reader.commitRange({ base: null, head: at.topic!, limit: 1 })).map((c) => c.oid),
    ).toEqual([at.topic]);
  });

  it("blames every line on the commit git blames", async () => {
    for (const [ref, path] of [
      ["main", "src/a.txt"],
      ["main", "src/c.txt"],
      ["topic", "src/c.txt"],
    ] as const) {
      const porcelain = await gitOut(["blame", "--porcelain", ref, "--", path], { cwd: work });
      const expected: string[] = [];
      for (const line of porcelain.split("\n")) {
        const match = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
        if (match) expected[Number(match[2]) - 1] = match[1]!;
      }
      const blame = await reader.blame({ ref, path });
      const got: string[] = [];
      for (const range of blame.ranges) {
        for (let i = 0; i < range.lineCount; i++) got[range.startLine - 1 + i] = range.commitOid;
        expect(blame.commits[range.commitOid]?.oid).toBe(range.commitOid);
      }
      expect(got, `${ref}:${path}`).toEqual(expected);
      expect(blame.blob.path).toBe(path);
    }
    // Lines that came through the rename name the old path, and where to look before it.
    const renamed = await reader.blame({ ref: "main", path: "src/c.txt" });
    expect(renamed.ranges.some((range) => range.originalPath === "src/b.txt")).toBe(true);
    const changed = renamed.ranges.find((range) => range.commitOid === fixture.at.rename);
    expect(changed).toMatchObject({ startLine: 30, lineCount: 1, originalPath: "src/c.txt" });

    await expect(reader.blame({ ref: "main", path: "bin/data.bin" })).rejects.toMatchObject({
      code: "not_a_file",
    });
    await expect(reader.blame({ ref: "main", path: "src" })).rejects.toMatchObject({
      code: "not_a_file",
    });
    await expect(reader.blame({ ref: "main", path: "big.txt" })).rejects.toMatchObject({
      code: "too_large",
    });
  });

  it("anchors a review comment to the hunk that shows its lines", async () => {
    const { at } = fixture;
    const baseOid = await gitOut(["merge-base", "main", "topic"], { cwd: work });
    const right = await reader.diffAnchor({
      baseOid,
      headOid: at.topic!,
      path: "src/c.txt",
      side: "RIGHT",
      line: 1,
    });
    expect(right?.lines.at(-1)).toMatchObject({ type: "add", content: "first", newLine: 1 });
    const left = await reader.diffAnchor({
      baseOid,
      headOid: at.topic!,
      path: "src/c.txt",
      side: "LEFT",
      line: 1,
    });
    expect(left?.lines.at(-1)).toMatchObject({ type: "delete", content: "line 1", oldLine: 1 });
    const context = await reader.diffAnchor({
      baseOid,
      headOid: at.topic!,
      path: "src/c.txt",
      side: "RIGHT",
      line: 4,
      startLine: 2,
    });
    expect(context?.lines.map((line) => line.newLine)).toEqual([null, 1, 2, 3, 4]);
    expect(context).toMatchObject({ newStart: 1, newLines: 4, oldLines: 4 });
    // Line 20 is not in the diff: nothing to anchor to.
    expect(
      await reader.diffAnchor({
        baseOid,
        headOid: at.topic!,
        path: "src/c.txt",
        side: "RIGHT",
        line: 20,
      }),
    ).toBeNull();
    expect(
      await reader.diffAnchor({
        baseOid,
        headOid: at.topic!,
        path: "README.md",
        side: "RIGHT",
        line: 1,
      }),
    ).toBeNull();
  });

  it("lists branches and tags with what Git knows of them", async () => {
    const branches = await reader.listBranches({ limit: 100 });
    expect(branches.items[0]).toMatchObject({ name: "main", ahead: null, behind: null });
    expect(branches.items.map((branch) => branch.name).sort()).toEqual([
      "conflict",
      "feature",
      "main",
      "topic",
    ]);
    for (const branch of branches.items.slice(1)) {
      const [behind, ahead] = (
        await gitOut(["rev-list", "--left-right", "--count", `main...${branch.name}`], {
          cwd: work,
        })
      )
        .split("\t")
        .map(Number);
      expect([branch.ahead, branch.behind], branch.name).toEqual([ahead, behind]);
    }
    // After the default branch, newest commit first.
    expect(branches.items.map((branch) => branch.name)).toEqual([
      "main",
      "topic",
      "conflict",
      "feature",
    ]);
    const page = await reader.listBranches({ limit: 2 });
    expect(page.items).toHaveLength(2);
    const rest = await reader.listBranches({ limit: 2, cursor: page.nextCursor! });
    expect(rest.items.map((branch) => branch.name)).toEqual(["conflict", "feature"]);
    expect(rest.nextCursor).toBeNull();
    expect((await reader.listBranches({ limit: 10, q: "TOP" })).items).toHaveLength(1);
    // Every commit of the fixture is from 2023.
    expect((await reader.listBranches({ limit: 10, view: "active" })).items).toEqual([]);
    expect((await reader.listBranches({ limit: 10, view: "stale" })).items).toHaveLength(4);
    expect(
      (await reader.listBranches({ limit: 10, view: "mine", authorEmails: ["ada@example.com"] }))
        .items,
    ).toHaveLength(4);
    expect(await reader.getBranch("nope")).toBeNull();

    const tags = await reader.listTags({ limit: 10 });
    expect(tags.items.map((tag) => tag.name)).toEqual(["v2", "v1"]);
    expect(tags.items[0]).toMatchObject({
      annotated: true,
      message: "Second release\n",
      tagger: { name: "Cy Committer" },
      oid: await gitOut(["rev-parse", "v2"], { cwd: work }),
    });
    expect(tags.items[0]!.commit?.oid).toBe(fixture.at.merge);
    expect(tags.items[1]).toMatchObject({ annotated: false, tagger: null, message: null });

    const refs = await reader.listRefs({ limit: 2 });
    expect(refs.branches.map((branch) => branch.name)).toEqual(["main", "topic"]);
    expect(refs.branchesTruncated).toBe(true);
    expect(refs.tags).toEqual([
      { name: "v2", oid: fixture.at.merge },
      { name: "v1", oid: fixture.at.c2 },
    ]);
    expect(refs.tagsTruncated).toBe(false);
  });

  it("says a size without reading the object, whole or delta", async () => {
    // Repacked hard, so most objects are deltas of others.
    const packed = join(tempDir("packed"), "repo.git");
    await git(["clone", "-q", "--bare", work, packed]);
    await git(["repack", "-adfq", "--depth=50", "--window=50"], { cwd: packed });
    const repo = await hub.open("repo-sizes");
    await git(["push", "-q", repo.url, "--all"], { cwd: packed });
    const objects = await repo.repository.objects();
    const listed = (
      await gitOut(
        [
          "cat-file",
          "--batch-all-objects",
          "--batch-check=%(objectname) %(objectsize) %(deltabase)",
        ],
        { cwd: packed },
      )
    ).split("\n");
    let deltas = 0;
    for (const line of listed) {
      const [oid, size, base] = line.split(" ");
      if (base !== "0".repeat(40)) deltas++;
      if (await objects.has(oid!)) expect(await objects.size(oid!), oid).toBe(Number(size));
    }
    expect(deltas).toBeGreaterThan(5);
    expect(await objects.size("f".repeat(40))).toBeNull();
  });

  it("creates and deletes branches by compare-and-swap, and announces them", async () => {
    const repo = await fresh("repo-branches");
    const mine = hub.reader("repo-branches");
    repo.events.length = 0;
    const created = await mine.createBranch({ name: "release/1", from: "v1", actor: ACTOR });
    expect(created).toMatchObject({ name: "release/1", commit: { oid: fixture.at.c2 } });
    expect(repo.events.at(-1)).toMatchObject({
      type: "push",
      actor: ACTOR,
      updates: [{ name: "refs/heads/release/1", newOid: fixture.at.c2, forced: false }],
    });
    await expect(
      mine.createBranch({ name: "release/1", from: "main", actor: ACTOR }),
    ).rejects.toMatchObject({ code: "ref_exists" });
    await expect(
      mine.createBranch({ name: "bad..name", from: "main", actor: ACTOR }),
    ).rejects.toMatchObject({ code: "invalid_ref" });
    await expect(
      mine.createBranch({ name: "other", from: "nope", actor: ACTOR }),
    ).rejects.toMatchObject({ code: "ref_not_found" });

    await expect(
      mine.deleteBranch({ name: "release/1", expectedOid: fixture.at.main, actor: ACTOR }),
    ).rejects.toMatchObject({ code: "head_moved" });
    expect(await mine.deleteBranch({ name: "release/1", actor: ACTOR })).toEqual({
      oid: fixture.at.c2,
    });
    await expect(mine.deleteBranch({ name: "release/1", actor: ACTOR })).rejects.toMatchObject({
      code: "ref_not_found",
    });
    // A deleted branch's commit can be given a name again by its id.
    await mine.deleteBranch({ name: "topic", actor: ACTOR });
    const restored = await mine.createBranch({
      name: "topic",
      from: fixture.at.topic!,
      actor: null,
    });
    expect(restored.commit.oid).toBe(fixture.at.topic);

    await mine.setDefaultBranch("feature");
    expect((await mine.resolveRef(undefined)).name).toBe("feature");
    await expect(mine.setDefaultBranch("nope")).rejects.toMatchObject({ code: "ref_not_found" });
  });

  it("merges with a merge commit, a squash and a rebase, to the trees git makes", async () => {
    const oracle = await scratch();
    const env = { GIT_AUTHOR_DATE: "1700090000 +0000", GIT_COMMITTER_DATE: "1700090000 +0000" };
    const input = {
      baseRef: "main",
      headRepositoryId: "",
      headOid: fixture.at.topic!,
      title: "Merge the topic (#4)",
      message: "Three commits.",
      committer: MERGER,
      actor: ACTOR,
    };

    // A merge commit.
    {
      const repo = await fresh("repo-merge");
      repo.events.length = 0;
      const mine = hub.reader("repo-merge");
      expect(
        await mine.mergeability({
          baseRef: "main",
          headRepositoryId: "repo-merge",
          headOid: input.headOid,
        }),
      ).toMatchObject({
        state: "clean",
        conflictFiles: [],
        baseOid: fixture.at.main,
        mergeBaseOid: fixture.at.c7,
        aheadBy: 3,
        behindBy: 1,
      });
      const outcome = await mine.merge({
        ...input,
        headRepositoryId: "repo-merge",
        method: "merge",
      });
      expect(outcome.merged).toBe(true);
      const { dir, oid } = await fetched(repo, "main");
      expect(outcome).toEqual({ merged: true, commitOid: oid });
      await git(["checkout", "-q", "-B", "m", "main"], { cwd: oracle });
      await git(["merge", "-q", "--no-ff", "topic", "-m", "x"], { cwd: oracle, env });
      expect(await treeOf(dir, oid)).toBe(await treeOf(oracle, "HEAD"));
      expect(await gitOut(["log", "-1", "--format=%P", oid], { cwd: dir })).toBe(
        `${fixture.at.main} ${fixture.at.topic}`,
      );
      // Merged: the head is in main's history.
      expect(await mine.landed({ baseRef: "main", heads: [input.headOid] })).toEqual({
        baseOid: oid,
        heads: [{ landing: "contained", commitOid: oid }],
      });
      expect(await gitOut(["log", "-1", "--format=%an <%ae>|%cn|%B", oid], { cwd: dir })).toBe(
        "Mo Merger <mo@example.com>|Mo Merger|Merge the topic (#4)\n\nThree commits.",
      );
      // The same event a push sends, by the person who merged.
      expect(repo.events).toEqual([
        {
          type: "push",
          repoId: "repo-merge",
          actor: ACTOR,
          updates: [
            { name: "refs/heads/main", oldOid: fixture.at.main, newOid: oid, forced: false },
          ],
          at: expect.any(Number),
        },
      ]);
    }

    // A squash: one commit on the base, by the head's author.
    {
      const repo = await fresh("repo-squash");
      const mine = hub.reader("repo-squash");
      // Not in yet; a head that is not here, or not a commit id, cannot be told.
      expect(
        await mine.landed({
          baseRef: "main",
          heads: [input.headOid, "e".repeat(40), "not a commit"],
        }),
      ).toEqual({ baseOid: fixture.at.main, heads: [null, null, null] });
      const outcome = await mine.merge({
        ...input,
        headRepositoryId: "repo-squash",
        method: "squash",
      });
      const { dir, oid } = await fetched(repo, "main");
      expect(outcome).toEqual({ merged: true, commitOid: oid });
      await git(["checkout", "-q", "-B", "s", "main"], { cwd: oracle });
      await git(["merge", "-q", "--squash", "topic"], { cwd: oracle });
      await git(["commit", "-q", "-m", "x"], { cwd: oracle, env });
      expect(await treeOf(dir, oid)).toBe(await treeOf(oracle, "HEAD"));
      expect(await gitOut(["log", "-1", "--format=%P|%an|%cn", oid], { cwd: dir })).toBe(
        `${fixture.at.main}|Ada Author|Mo Merger`,
      );
      // Squashed: not in main's history, but merging it again would change nothing.
      expect(
        await mine.landed({ baseRef: "main", heads: [input.headOid, fixture.at.conflict!] }),
      ).toEqual({ baseOid: oid, heads: [{ landing: "applied", commitOid: oid }, null] });
      // The commit a head landed in is the oldest of main's line that has it: for c7, c7 itself.
      expect(await mine.landed({ baseRef: "main", heads: [fixture.at.c7!] })).toEqual({
        baseOid: oid,
        heads: [{ landing: "contained", commitOid: fixture.at.c7 }],
      });
      await expect(mine.landed({ baseRef: "gone", heads: [] })).rejects.toMatchObject({
        code: "ref_not_found",
      });
      await expect(
        mine.landed({ baseRef: "main", heads: Array(101).fill(input.headOid) }),
      ).rejects.toMatchObject({ code: "too_large" });
    }

    // A rebase: each commit replayed, authors kept.
    {
      const repo = await fresh("repo-rebase");
      const mine = hub.reader("repo-rebase");
      const outcome = await mine.merge({
        ...input,
        headRepositoryId: "repo-rebase",
        method: "rebase",
      });
      const { dir, oid } = await fetched(repo, "main");
      expect(outcome).toEqual({ merged: true, commitOid: oid });
      await git(["checkout", "-q", "-B", "r", "topic"], { cwd: oracle });
      await git(["rebase", "-q", "main"], { cwd: oracle, env });
      const replayed = (rev: string, cwd: string) =>
        gitOut(["log", "--format=%T|%an|%s", `${fixture.at.main}..${rev}`], { cwd });
      expect(await replayed(oid, dir)).toBe(await replayed("HEAD", oracle));
      expect(await gitOut(["log", "-1", "--format=%cn", oid], { cwd: dir })).toBe("Mo Merger");
    }

    // A head already on top of the base is a fast-forward for a rebase, and still a merge commit for a merge.
    {
      const repo = await fresh("repo-ff");
      const mine = hub.reader("repo-ff");
      await mine.createBranch({ name: "old", from: fixture.at.c7!, actor: null });
      const ahead = { ...input, baseRef: "old", headRepositoryId: "repo-ff" };
      expect(await mine.merge({ ...ahead, method: "rebase" })).toEqual({
        merged: true,
        commitOid: fixture.at.topic,
      });
      expect((await fetched(repo, "old")).oid).toBe(fixture.at.topic);
      // Merged already: nothing to do, and nothing moves.
      expect(await mine.merge({ ...ahead, method: "merge" })).toEqual({
        merged: true,
        commitOid: fixture.at.topic,
      });
    }
  });

  it("reports conflicts and moves nothing", async () => {
    const repo = await fresh("repo-conflict");
    const mine = hub.reader("repo-conflict");
    repo.events.length = 0;
    const trial = await mine.mergeability({
      baseRef: "main",
      headRepositoryId: "repo-conflict",
      headOid: fixture.at.conflict!,
    });
    expect(trial).toMatchObject({ state: "conflicting", conflictFiles: ["src/a.txt"] });
    for (const method of ["merge", "squash", "rebase"] as const) {
      expect(
        await mine.merge({
          baseRef: "main",
          headRepositoryId: "repo-conflict",
          headOid: fixture.at.conflict!,
          method,
          title: "t",
          message: "",
          committer: MERGER,
          actor: ACTOR,
        }),
        method,
      ).toEqual({ merged: false, reason: "conflicts", conflictFiles: ["src/a.txt"] });
    }
    expect((await mine.getBranch("main"))?.commit.oid).toBe(fixture.at.main);
    expect(repo.events).toEqual([]);
    await expect(
      mine.mergeability({
        baseRef: "gone",
        headRepositoryId: "repo-conflict",
        headOid: fixture.at.topic!,
      }),
    ).rejects.toMatchObject({ code: "ref_not_found" });
    await expect(
      mine.mergeability({
        baseRef: "main",
        headRepositoryId: "repo-conflict",
        headOid: "e".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "ref_not_found" });
  });

  it("merges against the base as it is when the base moved under it", async () => {
    const repo = await fresh("repo-race");
    const mine = hub.reader("repo-race");
    // The base moves between the merge being computed and the branch being moved: once is retried.
    const original = repo.repository.writeObjects.bind(repo.repository);
    let races = 1;
    repo.repository.writeObjects = async (objects) => {
      const written = await original(objects);
      if (races-- > 0) {
        await hub.reader("repo-race").createBranch({ name: "tmp", from: "feature", actor: null });
        await repo.repository.applyUpdates(
          [{ name: "refs/heads/main", oldOid: fixture.at.main!, newOid: fixture.at.c7! }],
          { notify: false },
        );
      }
      return written;
    };
    const outcome = await mine.merge({
      baseRef: "main",
      headRepositoryId: "repo-race",
      headOid: fixture.at.topic!,
      method: "merge",
      title: "t",
      message: "",
      committer: MERGER,
      actor: ACTOR,
    });
    expect(outcome.merged).toBe(true);
    const { dir, oid } = await fetched(repo, "main");
    // Merged onto where the base went, not where it was.
    expect(await gitOut(["log", "-1", "--format=%P", oid], { cwd: dir })).toBe(
      `${fixture.at.c7} ${fixture.at.topic}`,
    );

    // A base that keeps moving is the caller's to hear about.
    await repo.repository.applyUpdates(
      [{ name: "refs/heads/main", oldOid: oid, newOid: fixture.at.c2! }],
      { notify: false },
    );
    let flip = false;
    repo.repository.writeObjects = async (objects) => {
      const written = await original(objects);
      const current = (await mine.getBranch("main"))!.commit.oid;
      flip = !flip;
      await repo.repository.applyUpdates(
        [
          {
            name: "refs/heads/main",
            oldOid: current,
            newOid: flip ? fixture.at.c6! : fixture.at.c2!,
          },
        ],
        { notify: false },
      );
      return written;
    };
    expect(
      await mine.merge({
        baseRef: "main",
        headRepositoryId: "repo-race",
        headOid: fixture.at.topic!,
        method: "squash",
        title: "t",
        message: "",
        committer: MERGER,
        actor: ACTOR,
      }),
    ).toEqual({ merged: false, reason: "base_moved" });
    repo.repository.writeObjects = original;
  });

  it("brings a head branch up to date by merge and by rebase", async () => {
    const oracle = await scratch();
    const env = { GIT_AUTHOR_DATE: "1700090000 +0000", GIT_COMMITTER_DATE: "1700090000 +0000" };
    const input = {
      headRef: "topic",
      baseRepositoryId: "repo-update",
      baseRef: "main",
      committer: MERGER,
      actor: ACTOR,
    };
    const repo = await fresh("repo-update");
    const mine = hub.reader("repo-update");
    await expect(
      mine.updateBranch({ ...input, method: "merge", expectedHeadOid: fixture.at.main }),
    ).rejects.toMatchObject({ code: "head_moved" });
    const merged = await mine.updateBranch({
      ...input,
      method: "merge",
      expectedHeadOid: fixture.at.topic,
    });
    expect(merged.updated).toBe(true);
    const got = await fetched(repo, "topic");
    await git(["checkout", "-q", "-B", "u", "topic"], { cwd: oracle });
    await git(["merge", "-q", "--no-ff", "main", "-m", "x"], { cwd: oracle, env });
    expect(await treeOf(got.dir, got.oid)).toBe(await treeOf(oracle, "HEAD"));
    expect(await gitOut(["log", "-1", "--format=%P|%s", got.oid], { cwd: got.dir })).toBe(
      `${fixture.at.topic} ${fixture.at.main}|Merge branch 'main' into topic`,
    );
    expect(await mine.updateBranch({ ...input, method: "merge" })).toEqual({
      updated: false,
      reason: "up_to_date",
      headOid: got.oid,
    });

    const second = await fresh("repo-update-2");
    second.events.length = 0;
    const other = hub.reader("repo-update-2");
    const rebased = await other.updateBranch({
      ...input,
      baseRepositoryId: "repo-update-2",
      method: "rebase",
    });
    expect(rebased.updated).toBe(true);
    const after = await fetched(second, "topic");
    await git(["checkout", "-q", "-B", "ur", "topic"], { cwd: oracle });
    await git(["rebase", "-q", "main"], { cwd: oracle, env });
    expect(await treeOf(after.dir, after.oid)).toBe(await treeOf(oracle, "HEAD"));
    // A rebase is a forced update of the head branch, and says so.
    expect(second.events.at(-1)?.updates).toEqual([
      { name: "refs/heads/topic", oldOid: fixture.at.topic, newOid: after.oid, forced: true },
    ]);
    expect(
      await other.updateBranch({
        ...input,
        headRef: "conflict",
        baseRepositoryId: "repo-update-2",
        method: "merge",
      }),
    ).toEqual({ updated: false, reason: "conflicts", conflictFiles: ["src/a.txt"] });
  });

  it("compares, checks and merges a pull request from a fork", async () => {
    const forks = new Hub();
    const base = await fresh("base", forks);
    const fork = await forks.open("fork");
    const baseReader = forks.reader("base");
    const forkReader = forks.reader("fork");
    const stats = await forkReader.forkFrom("base", { defaultBranchOnly: false });
    expect(stats).toMatchObject({ branchCount: 4, tagCount: 2, isEmpty: false });

    // Work that only the fork has.
    const clone = join(tempDir("fork"), "repo");
    await git(["clone", "-q", fork.url, clone]);
    await git(["checkout", "-q", "-b", "patch"], { cwd: clone });
    await commitFile(clone, "src/patch.txt", "from a fork\n", "fork: a patch");
    const headOid = await commitFile(
      clone,
      "src/a.txt",
      lines(21, { 2: "TWO", 5: "five", 15: "fifteen" }),
      "fork: one more line",
    );
    await git(["push", "-q", "origin", "patch"], { cwd: clone });
    const baseObjects = await base.repository.objects();
    expect(await baseObjects.has(headOid)).toBe(false);

    // Comparing reads the head from the fork by name.
    const comparison = await baseReader.compare({
      base: "main",
      head: "patch",
      headRepositoryId: "fork",
    });
    expect(comparison).toMatchObject({
      head: { name: "patch", kind: "branch", commitOid: headOid },
      mergeBaseOid: fixture.at.main,
      ahead: 2,
      behind: 0,
      mergeable: true,
    });
    expect(comparison.files.map((file) => file.path)).toEqual(["src/a.txt", "src/patch.txt"]);
    await expect(
      baseReader.compare({ base: "main", head: "nope", headRepositoryId: "fork" }),
    ).rejects.toMatchObject({ code: "ref_not_found" });

    // The pull request's ref, in the base, fetchable like any other.
    await baseReader.setPullRef({ number: 12, headRepositoryId: "fork", oid: headOid });
    expect((await fetched(base, "refs/pull/12/head")).oid).toBe(headOid);
    // Nobody is told: it is not a push.
    expect(base.events.filter((event) => event.updates[0]!.name.startsWith("refs/pull/"))).toEqual(
      [],
    );

    expect(
      await baseReader.mergeability({ baseRef: "main", headRepositoryId: "fork", headOid }),
    ).toMatchObject({ state: "clean", aheadBy: 2, behindBy: 0, mergeBaseOid: fixture.at.main });
    const range = await baseReader.commitsBetween(
      { base: fixture.at.main!, head: headOid, headRepositoryId: "fork" },
      { limit: 10 },
    );
    expect(range.items.map((commit) => commit.summary)).toEqual([
      "fork: a patch",
      "fork: one more line",
    ]);
    const anchor = await baseReader.diffAnchor({
      baseOid: fixture.at.main!,
      headOid,
      headRepositoryId: "fork",
      path: "src/patch.txt",
      side: "RIGHT",
      line: 1,
    });
    expect(anchor?.lines).toEqual([
      { type: "add", content: "from a fork", oldLine: null, newLine: 1 },
    ]);

    // The fork's branch is brought up to date from the base, across repositories.
    const upstream = join(tempDir("upstream"), "repo");
    await git(["clone", "-q", base.url, upstream]);
    const moved = await commitFile(upstream, "docs/later.md", "later\n", "docs: later");
    await git(["push", "-q", "origin", "main"], { cwd: upstream });
    const updated = await forkReader.updateBranch({
      headRef: "patch",
      expectedHeadOid: headOid,
      baseRepositoryId: "base",
      baseRef: "main",
      method: "merge",
      committer: MERGER,
      actor: ACTOR,
    });
    expect(updated.updated).toBe(true);
    const newHead = (updated as { headOid: string }).headOid;
    expect(fork.events.at(-1)?.updates[0]).toMatchObject({
      name: "refs/heads/patch",
      oldOid: headOid,
      newOid: newHead,
    });

    // And merged into the base.
    base.events.length = 0;
    await baseReader.setPullRef({ number: 12, headRepositoryId: "fork", oid: newHead });
    const outcome = await baseReader.merge({
      baseRef: "main",
      headRepositoryId: "fork",
      headOid: newHead,
      method: "merge",
      title: "Merge pull request #12",
      message: "",
      committer: MERGER,
      actor: ACTOR,
    });
    expect(outcome.merged).toBe(true);
    const merged = await fetched(base, "main");
    expect(await gitOut(["log", "-1", "--format=%P", merged.oid], { cwd: merged.dir })).toBe(
      `${moved} ${newHead}`,
    );
    expect(await gitOut(["show", `${merged.oid}:src/patch.txt`], { cwd: merged.dir })).toBe(
      "from a fork",
    );
    expect(base.events).toHaveLength(1);
    expect(base.events[0]).toMatchObject({ actor: ACTOR, repoId: "base" });

    // A closed pull request's ref can be removed; deleting either repository leaves the other whole.
    await baseReader.setPullRef({ number: 12, headRepositoryId: "fork", oid: null });
    expect(base.repository.listRefs().some((ref) => ref.name.startsWith("refs/pull/"))).toBe(false);
    await forkReader.destroy();
    await expect(forkReader.stats()).rejects.toMatchObject({ code: "unavailable" });
    await fetched(base, "main");
    await forks.close();
  });

  it("forks only the default branch when asked", async () => {
    const forks = new Hub();
    await fresh("base", forks);
    await forks.open("fork");
    const stats = await forks.reader("fork").forkFrom("base", { defaultBranchOnly: true });
    expect(stats).toMatchObject({ branchCount: 1, tagCount: 0 });
    expect((await forks.reader("fork").resolveRef(undefined)).commitOid).toBe(fixture.at.main);
    await forks.close();
  });

  it("starts a repository empty or with a first commit, and destroys it", async () => {
    const empty = await hub.open("repo-empty");
    const none = hub.reader("repo-empty");
    // Never initialised: there is no storage to speak of.
    await expect(none.stats()).rejects.toMatchObject({ code: "unavailable" });
    await expect(none.tree({ ref: undefined, path: "", lastCommits: true })).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await none.init({ defaultBranch: "trunk" })).toEqual({ headOid: null });
    expect(await none.stats()).toEqual({
      sizeBytes: 0,
      branchCount: 0,
      tagCount: 0,
      isEmpty: true,
    });
    await expect(none.resolveRef(undefined)).rejects.toMatchObject({ code: "repository_empty" });
    expect(await none.readme({ ref: undefined, path: "" })).toBeNull();
    expect((await none.listBranches({ limit: 10 })).items).toEqual([]);
    expect(empty.repository.head()).toBe("refs/heads/trunk");

    const started = await hub.open("repo-started");
    const mine = hub.reader("repo-started", "widgets");
    const { headOid } = await mine.init({
      defaultBranch: "main",
      initialize: {
        readme: true,
        gitignore: "Terraform",
        license: "MIT",
        author: { name: "Ada Author", email: "ada@example.com" },
        title: "widgets",
        description: "Things that turn.",
      },
    });
    expect(headOid).toMatch(/^[0-9a-f]{40}$/);
    // Calling it again changes nothing.
    expect(await mine.init({ defaultBranch: "main", initialize: undefined })).toEqual({
      headOid: null,
    });
    const { dir, oid } = await fetched(started, "main");
    expect(oid).toBe(headOid);
    expect((await gitOut(["ls-tree", "--name-only", oid], { cwd: dir })).split("\n")).toEqual([
      ".gitignore",
      "LICENSE",
      "README.md",
    ]);
    expect(await gitOut(["show", `${oid}:README.md`], { cwd: dir })).toBe(
      "# widgets\n\nThings that turn.",
    );
    expect(await gitOut(["show", `${oid}:LICENSE`], { cwd: dir })).toContain(
      `Copyright (c) ${new Date().getUTCFullYear()} Ada Author`,
    );
    expect(await gitOut(["log", "-1", "--format=%an|%s", oid], { cwd: dir })).toBe(
      "Ada Author|Initial commit",
    );
    // A template nobody knows is left out, not refused.
    await hub.open("repo-odd-init");
    const unknown = await hub.reader("repo-odd-init").init({
      defaultBranch: "main",
      initialize: {
        readme: false,
        gitignore: "Klingon",
        license: "Apache-2.0",
        author: { name: "Ada", email: "ada@example.com" },
        title: "x",
        description: null,
      },
    });
    const listing = await hub
      .reader("repo-odd-init")
      .tree({ ref: undefined, path: "", lastCommits: true });
    expect(unknown.headOid).toBe(listing.ref.commitOid);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["LICENSE"]);
    expect(listing.entries[0]!.size).toBe(11358);

    expect((await mine.stats()).sizeBytes).toBeGreaterThan(0);
    await mine.destroy();
    await mine.destroy();
    await expect(mine.stats()).rejects.toMatchObject({ code: "unavailable" });
    expect(
      [...hub.bucket.objects.keys()].some((key) => key.startsWith("repos/repo-started/")),
    ).toBe(false);
  });

  it("travels to the Worker as values: answers, and refusals with their codes", async () => {
    const repository = hub.repos.get("repo-1")!.repository;
    const state = new ReaderState();
    // What `RepoDO.reader` does, behind what a stub looks like to the Worker.
    const env = {
      REPO: {
        idFromName: (name: string) => name,
        get: (id: string) => ({
          reader: (
            repoId: string,
            locator: { owner: string; name: string },
            method: string,
            args: readonly unknown[],
          ) => {
            expect(repoId).toBe(id);
            return callReader(
              localRepoReader(repository, state, { id: repoId, ...locator }),
              method,
              structuredClone(args),
            ).then((reply) => structuredClone(reply));
          },
        }),
      },
    };
    const remote = durableRepoReader(env as never, {
      id: "repo-1",
      owner: "acme",
      name: "fixture",
    });
    expect(await remote.resolveRef("main")).toEqual(await reader.resolveRef("main"));
    expect(await remote.tree({ ref: undefined, path: "src", lastCommits: true })).toEqual(
      await reader.tree({ ref: undefined, path: "src", lastCommits: true }),
    );
    expect(await remote.commitDiff(fixture.at.c7!, { limit: 5 })).toEqual(
      await reader.commitDiff(fixture.at.c7!, { limit: 5 }),
    );
    const refusal = await remote.blob({ ref: undefined, path: "nope" }).catch((error) => error);
    expect(refusal).toBeInstanceOf(RepoReaderError);
    expect(refusal).toMatchObject({ code: "path_not_found" });
    await expect(callReader(reader, "constructor", [])).rejects.toThrow(/no reader method/);

    // The platform failing to reach the object is the storage being away, not a bug of ours.
    const down = durableRepoReader(
      {
        REPO: {
          idFromName: (name: string) => name,
          get: () => ({
            reader: () =>
              Promise.reject(Object.assign(new Error("overloaded"), { overloaded: true })),
          }),
        },
      } as never,
      { id: "repo-1", owner: "acme", name: "fixture" },
    );
    await expect(down.stats()).rejects.toMatchObject({ code: "unavailable" });
  });
});

describeGit("commits no ref reaches", () => {
  let repo: NodeRepo;

  beforeAll(async () => {
    resetClock();
    repo = await startNodeRepo("repo-orphans");
  });
  afterAll(async () => {
    expect(repo.errors).toEqual([]);
    await repo.close();
  });

  it("are not read by id once a forced push left them behind, in full or abbreviated", async () => {
    const work = await initRepo("orphans");
    const kept = await commitFile(work, "README.md", "# kept\n", "kept");
    const dropped = await commitFile(work, "secret.txt", "left behind\n", "dropped");
    await git(["push", "-q", repo.url, "main"], { cwd: work });
    const reader = localRepoReader(repo.repository, new ReaderState(), {
      id: "repo-orphans",
      owner: "acme",
      name: "orphans",
    });
    // While a branch reaches it, the id reads like any other.
    expect((await reader.commit(dropped)).commit.oid).toBe(dropped);

    await git(["reset", "-q", "--hard", kept], { cwd: work });
    await git(["push", "-q", "--force", repo.url, "main"], { cwd: work });
    // The objects are still stored: only the refs no longer reach them.
    expect(await (await repo.repository.objects()).has(dropped)).toBe(true);
    for (const id of [dropped, dropped.slice(0, 12), dropped.slice(0, 7)]) {
      await expect(reader.commit(id)).rejects.toMatchObject({ code: "ref_not_found" });
      await expect(reader.commitDiff(id, { limit: 10 })).rejects.toMatchObject({
        code: "ref_not_found",
      });
      await expect(reader.tree({ ref: id, path: "", lastCommits: false })).rejects.toMatchObject({
        code: "ref_not_found",
      });
      await expect(reader.blob({ ref: id, path: "secret.txt" })).rejects.toMatchObject({
        code: "ref_not_found",
      });
      await expect(reader.resolveRef(id)).rejects.toMatchObject({ code: "ref_not_found" });
      await expect(reader.compare({ base: kept, head: id })).rejects.toMatchObject({
        code: "ref_not_found",
      });
    }
    // What a ref still reaches is read by id as before.
    expect((await reader.resolveRef(kept.slice(0, 8))).commitOid).toBe(kept);
    expect((await reader.commit(kept)).commit.oid).toBe(kept);
  });
});
