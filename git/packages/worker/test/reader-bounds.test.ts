/**
 * The reader's bounds on repositories made to cost as much as they can,
 * pushed by `git` to the Node stand-ins: a directory too large to list, a
 * page of diff whose lines are each hundreds of kilobytes, a commit that
 * changes many files between the same two blobs, a message of hundreds of
 * kilobytes, a directory wider than the file table. Each asserts a count or
 * a refusal, never a time.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReaderState, callReader, localRepoReader } from "../src/repo/queries";
import type { ReaderLimits } from "../src/repo/queries/session";
import type { RepoReader } from "../src/repo/reader";
import { cleanupTempDirs, commitFile, git, gitOut, hasGit, initRepo, run } from "./support/git";
import { type NodeRepo, startNodeRepo } from "./support/node-server";

afterAll(cleanupTempDirs);

const LOCATOR = { id: "repo-1", owner: "acme", name: "infra" };

describe.skipIf(!hasGit)("the reader on repositories made to cost the most", () => {
  let repo: NodeRepo;
  let work: string;
  let wide: string;
  let longLines: string;
  let samePair: string;
  let longMessage: string;

  const reader = (limits: Partial<ReaderLimits> = {}): RepoReader =>
    localRepoReader(repo.repository, new ReaderState(), LOCATOR, { limits });

  /** A commit of `tree` on top of HEAD, on its own branch. */
  const branchOf = async (name: string, tree: string, message: string): Promise<string> => {
    const head = await gitOut(["rev-parse", "HEAD"], { cwd: work });
    const env = { GIT_AUTHOR_DATE: "1700000000 +0000", GIT_COMMITTER_DATE: "1700000000 +0000" };
    const commit = await gitOut(["commit-tree", tree, "-p", head, "-m", message], {
      cwd: work,
      env,
    });
    await git(["update-ref", `refs/heads/${name}`, commit], { cwd: work });
    return commit;
  };

  beforeAll(async () => {
    repo = await startNodeRepo("repo-1");
    work = await initRepo("bounds");
    await commitFile(work, "README.md", "# infra\n", "start");

    // 40 000 names in one directory: a tree of some 1.3 MB, over git-ops' 1 MiB to list.
    const blob = await gitOut(["hash-object", "-w", "README.md"], { cwd: work });
    const lines: string[] = [];
    for (let i = 0; i < 40_000; i++)
      lines.push(`100644 blob ${blob}\tn${String(i).padStart(6, "0")}`);
    writeFileSync(join(work, "..", "wide.list"), `${lines.join("\n")}\n`);
    const wideTree = (await run("sh", ["-c", "git mktree < ../wide.list"], { cwd: work })).stdout;
    wide = await branchOf("wide", wideTree, "a very wide directory");

    // Eight files of one 300 000-character line each.
    for (let i = 0; i < 8; i++) {
      writeFileSync(
        join(work, `long-${i}.txt`),
        `${String.fromCharCode(97 + i).repeat(300_000)}\n`,
      );
    }
    longLines = await commitFile(work, "long-0.txt", `${"a".repeat(300_000)}\n`, "long lines");

    // Forty files that each go from the same blob to the same other blob.
    const before = Array.from({ length: 200 }, (_, k) => `line ${k}\n`).join("");
    const after = Array.from(
      { length: 200 },
      (_, k) => `line ${k}${k % 3 === 0 ? " edited" : ""}\n`,
    ).join("");
    for (let i = 0; i < 40; i++) writeFileSync(join(work, `same-${i}.txt`), before);
    await commitFile(work, "same-0.txt", before, "forty copies");
    for (let i = 0; i < 40; i++) writeFileSync(join(work, `same-${i}.txt`), after);
    samePair = await commitFile(work, "same-0.txt", after, "forty identical edits");

    longMessage = await commitFile(
      work,
      "notes.txt",
      "notes\n",
      `subject\n\n${"body text ".repeat(20_000)}`,
    );
    await git(["push", "-q", repo.url, "--all"], { cwd: work });
  });
  afterAll(async () => {
    expect(repo.errors).toEqual([]);
    await repo.close();
  });

  it("refuses to list a directory too large to parse, as too_large and not a failure", async () => {
    const reply = await callReader(reader(), "tree", [
      { ref: "wide", path: "", lastCommits: true },
    ]);
    expect(reply).toMatchObject({ ok: false, code: "too_large" });
    // A file in it is still found by name: looking one up does not parse the directory.
    const file = await reader().blob({ ref: wide, path: "n012345" });
    expect(file.text).toBe("# infra\n");
  });

  it("ends a page of diff once its hunk text is over diffPageBytes", async () => {
    const page = await reader({ diffPageBytes: 700_000 }).commitDiff(longLines, { limit: 100 });
    const rendered = page.files.filter((file) => file.hunks.length > 0);
    // Each file is a 300 000-character line added: three fit before the page is full.
    expect(page.files).toHaveLength(8);
    expect(rendered.length).toBe(3);
    expect(page.files.slice(3).every((file) => file.tooLarge && file.hunks.length === 0)).toBe(
      true,
    );
    const whole = await reader().commitDiff(longLines, { limit: 100 });
    expect(whole.files.every((file) => file.hunks.length > 0)).toBe(true);
  });

  it("diffs a pair of blobs once however many files share it", async () => {
    // 400 lines a pair, under a budget of 401: the forty files cost what one does.
    const once = await reader({ diffCountLines: 401 }).commit(samePair);
    expect(once.files).toHaveLength(40);
    expect(once.filesTruncated).toBe(false);
    expect(once.files.every((file) => file.additions === 67 && file.deletions === 67)).toBe(true);
  });

  it("cuts a long message for a commit page and further for a list", async () => {
    const shown = await reader({ shownMessageBytes: 1000 }).commit(longMessage);
    expect(shown.commit.message.length).toBeLessThanOrEqual(1000);
    expect(shown.commit.summary).toBe("subject");
    expect(shown.commit.hasBody).toBe(true);
    const listed = await reader({ listedMessageBytes: 100 }).listCommits({
      ref: "main",
      limit: 1,
      path: "notes.txt",
    });
    expect(listed.items.map((item) => item.oid)).toEqual([longMessage]);
    expect(listed.items[0]!.summary).toBe("subject");
  });

  it("walks the last commits of the listed names only", async () => {
    const limited = reader({ maxTreeEntries: 5 });
    const listing = await limited.tree({ ref: "main", path: "", lastCommits: true });
    expect(listing.entries).toHaveLength(5);
    expect(listing.truncated).toBe(true);
    const last = await limited.treeLastCommits({ ref: "main", path: "" });
    expect(Object.keys(last.commits).sort()).toEqual(
      listing.entries.map((entry) => entry.name).sort(),
    );
  });
});
