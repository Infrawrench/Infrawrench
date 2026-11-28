import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { decodeText, encodeText } from "@infrawrench/git-core";
import {
  type MergeOutcome,
  type NewObject,
  analyzeMerge,
  createCommit,
  landedIn,
  mergeCommits,
  mergeText,
  mergeTrees,
  mergeWithCommit,
  normalizeMessage,
  rebaseMerge,
  signature,
  squashMerge,
} from "../src";
import {
  Repo,
  cleanupTempDirs,
  describeGit,
  editLines,
  loadStore,
  prng,
  sourceFile,
  tempDir,
  text,
} from "./helpers";

afterAll(cleanupTempDirs);

/** Stores objects the package made in a real repository, the way the worker will, and returns git's ids. */
function writeObjects(repo: Repo, objects: readonly NewObject[]): void {
  for (const object of objects) {
    const oid = repo
      .raw(["hash-object", "-w", "-t", object.type, "--stdin"], { input: object.data })
      .stdout.toString()
      .trim();
    expect(oid).toBe(object.oid);
  }
}

describeGit("text merge against git merge-file", () => {
  it("gives the same bytes and the same number of conflicts", () => {
    const dir = tempDir("merge-file");
    const next = prng(1234);
    // One repository for the `git` calls: merge-file itself needs none, the helper just wants a cwd.
    const repo = new Repo("merge-file-cwd");
    const merge = (base: string, ours: string, theirs: string, flags: string[]) => {
      writeFileSync(join(dir, "base"), base);
      writeFileSync(join(dir, "ours"), ours);
      writeFileSync(join(dir, "theirs"), theirs);
      return repo.raw(
        [
          "merge-file",
          "-p",
          ...flags,
          "-L",
          "mine",
          "-L",
          "orig",
          "-L",
          "yours",
          "ours",
          "base",
          "theirs",
        ],
        { cwd: dir, allowFailure: true },
      );
    };

    let conflicted = 0;
    let clean = 0;
    for (let round = 0; round < 160; round++) {
      const base = sourceFile(next, 20 + (next() % 80));
      const ours = [...base];
      const theirs = [...base];
      editLines(ours, next, 1 + (next() % 4));
      editLines(theirs, next, 1 + (next() % 4));
      // Now and then both sides make the same edit, which must not be a conflict.
      if (round % 7 === 0) {
        const at = next() % (Math.min(ours.length, theirs.length) + 1);
        ours.splice(at, 0, "shared insertion;");
        theirs.splice(at, 0, "shared insertion;");
      }
      const eol = round % 9 === 4 ? "\r\n" : "\n";
      const render = (lines: string[], final: boolean): string =>
        lines.length === 0 ? "" : lines.join(eol) + (final ? eol : "");
      const b = render(base, true);
      const o = render(ours, round % 11 !== 3);
      const t = render(theirs, round % 13 !== 5);

      for (const algorithm of ["histogram", "myers"] as const) {
        const expected = merge(b, o, t, [`--diff-algorithm=${algorithm}`]);
        const result = mergeText(encodeText(b), encodeText(o), encodeText(t), {
          ours: "mine",
          theirs: "yours",
          algorithm,
        });
        expect(decodeText(result.data), `round ${round} ${algorithm}`).toBe(
          expected.stdout.toString(),
        );
        expect(result.conflicts, `round ${round} ${algorithm}`).toBe(expected.status);
        if (result.conflicts > 0) conflicted++;
        else clean++;
      }
      const diff3 = merge(b, o, t, ["--diff-algorithm=histogram", "--diff3"]);
      expect(
        decodeText(
          mergeText(encodeText(b), encodeText(o), encodeText(t), {
            ours: "mine",
            theirs: "yours",
            base: "orig",
            style: "diff3",
          }).data,
        ),
        `round ${round} diff3`,
      ).toBe(diff3.stdout.toString());
      for (const favor of ["ours", "theirs", "union"] as const) {
        const favored = merge(b, o, t, ["--diff-algorithm=histogram", `--${favor}`]);
        const result = mergeText(encodeText(b), encodeText(o), encodeText(t), { favor });
        expect(decodeText(result.data), `round ${round} ${favor}`).toBe(favored.stdout.toString());
        expect(result.conflicts).toBe(0);
      }
    }
    expect(conflicted).toBeGreaterThan(40);
    expect(clean).toBeGreaterThan(40);
  });
});

interface Scenario {
  readonly ours: string;
  readonly theirs: string;
}

/** What `git merge-tree --write-tree` says: the tree, and the paths it lists as conflicted. */
function mergeTree(
  repo: Repo,
  ours: string,
  theirs: string,
): { tree: string; conflicts: string[] } {
  const result = repo.raw(
    [
      "-c",
      "merge.directoryRenames=false",
      "-c",
      "core.quotePath=false",
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      ours,
      theirs,
    ],
    { allowFailure: true },
  );
  expect([0, 1]).toContain(result.status);
  const lines = result.stdout.toString().replace(/\n$/, "").split("\n");
  return { tree: lines[0]!, conflicts: lines.slice(1).filter((line) => line !== "") };
}

describeGit("tree merge against git merge-tree", () => {
  it("matches over random pairs of branches", async () => {
    const repo = new Repo("merge-tree");
    const next = prng(98765);
    const dirs = ["app", "app/core", "lib", "docs"];
    const baseFiles = new Map<string, string[]>();
    for (let i = 0; i < 14; i++) {
      const path = `${dirs[i % dirs.length]}/f${i}.txt`;
      baseFiles.set(path, sourceFile(next, 25 + (next() % 50)));
      repo.write(path, text(baseFiles.get(path)!));
    }
    repo.write("app/tool.sh", "#!/bin/sh\necho tool\n");
    repo.write("lib/blob.bin", new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
    repo.symlink("f0.txt", "app/link");
    const base = repo.commit("base");

    let counter = 0;
    const mutate = (files: Map<string, string[]>, side: string): void => {
      const paths = [...files.keys()];
      const pick = paths[next() % paths.length]!;
      const action = next() % 22;
      if (action < 9) {
        editLines(files.get(pick)!, next);
        repo.write(pick, text(files.get(pick)!));
      } else if (action < 11) {
        // Sometimes the same new path on both sides: the name does not include the side.
        const shared = next() % 3 === 0;
        const path = `${dirs[next() % dirs.length]}/${shared ? "both" : side}-${shared ? next() % 3 : counter++}.txt`;
        files.set(path, sourceFile(next, 8 + (next() % 20)));
        repo.write(path, text(files.get(path)!));
      } else if (action < 13) {
        files.delete(pick);
        repo.remove(pick);
      } else if (action < 17) {
        const to = `${dirs[next() % dirs.length]}/${side}-moved-${counter++}.txt`;
        const lines = files.get(pick)!;
        files.delete(pick);
        repo.remove(pick);
        if (next() % 2 === 0) editLines(lines, next, 1);
        files.set(to, lines);
        repo.write(to, text(lines));
      } else if (action < 18) {
        repo.chmod(pick, next() % 2 === 0 ? 0o755 : 0o644);
      } else if (action < 19) {
        repo.write("lib/blob.bin", new Uint8Array([0, next() & 255, next() & 255, 3]));
      } else if (action < 20) {
        repo.symlink(`f${next() % 4}.txt`, "app/link");
      } else if (action < 21) {
        repo.write("app/tool.sh", `#!/bin/sh\necho ${side} ${next() % 3}\n`);
      } else {
        // A file where the other side may have a directory, or the reverse.
        const name = `docs/clash-${next() % 2}`;
        repo.remove(name);
        if (next() % 2 === 0) repo.write(name, `${side}\n`);
        else repo.write(`${name}/inner.txt`, `${side}\n`);
      }
    };
    const scenarios: Scenario[] = [];
    for (let i = 0; i < 120; i++) {
      for (const side of ["ours", "theirs"] as const) {
        repo.run("checkout", "-q", "-f", "-B", `${side}-${i}`, base);
        repo.run("clean", "-qfd");
        const files = new Map([...baseFiles].map(([path, lines]) => [path, [...lines]]));
        const count = 1 + (next() % 6);
        for (let k = 0; k < count; k++) mutate(files, side);
        repo.commit(`${side} ${i}`);
      }
      scenarios.push({ ours: `ours-${i}`, theirs: `theirs-${i}` });
    }

    const store = loadStore(repo);
    let clean = 0;
    let conflicted = 0;
    let sameConflictTree = 0;
    const kinds = new Set<string>();
    for (const { ours, theirs } of scenarios) {
      const expected = mergeTree(repo, ours, theirs);
      const result = await mergeCommits(store, repo.rev(ours), repo.rev(theirs), { ours, theirs });
      const label = `${ours} ${theirs}`;
      expect(result.bases).toEqual([base]);
      expect(
        result.conflicts.map((conflict) => conflict.path),
        label,
      ).toEqual([...expected.conflicts].sort());
      if (expected.conflicts.length === 0) {
        expect(result.tree, label).toBe(expected.tree);
        clean++;
      } else {
        conflicted++;
        if (result.tree === expected.tree) sameConflictTree++;
        for (const conflict of result.conflicts) kinds.add(conflict.kind);
      }
      // Whatever it says is new really is what the tree needs: git can read the tree back.
      writeObjects(repo, result.objects);
      expect(repo.run("cat-file", "-t", result.tree)).toBe("tree");
      repo.run("ls-tree", "-r", result.tree);
    }
    console.info(
      `git-ops parity: merge-tree: ${clean} clean, ${conflicted} with conflicts, ` +
        `${sameConflictTree} of those with an identical tree (kinds: ${[...kinds].sort().join(", ")})`,
    );
    expect(clean).toBeGreaterThan(15);
    expect(conflicted).toBeGreaterThan(15);
    // Content conflicts carry git's markers byte for byte, so most conflicted trees match too.
    expect(sameConflictTree).toBeGreaterThan(conflicted / 2);
    expect(kinds.has("content")).toBe(true);
    expect(kinds.has("modify-delete")).toBe(true);
    repo.run("fsck", "--strict", "--no-dangling");
  });

  it("merges a renamed file with edits from the other side", async () => {
    const repo = new Repo("rename-merge");
    const next = prng(9);
    const lines = sourceFile(next, 60);
    const other = sourceFile(next, 40);
    repo.write("src/old-name.txt", text(lines));
    repo.write("src/other.txt", text(other));
    const base = repo.commit("base");

    repo.run("checkout", "-q", "-b", "renamer");
    repo.remove("src/old-name.txt");
    const renamed = [...lines];
    renamed[2] = "changed by the renamer;";
    repo.write("lib/new-name.txt", text(renamed));
    repo.remove("src/other.txt");
    repo.write("lib/other-moved.txt", text(other));
    repo.commit("rename two files, edit one");

    repo.run("checkout", "-q", "-b", "editor", base);
    const edited = [...lines];
    edited[50] = "changed by the editor;";
    repo.write("src/old-name.txt", text(edited));
    const otherEdited = [...other, "one more line;"];
    repo.write("src/other.txt", text(otherEdited));
    repo.commit("edit both");

    const store = loadStore(repo);
    for (const [ours, theirs] of [
      ["renamer", "editor"],
      ["editor", "renamer"],
    ] as const) {
      const expected = mergeTree(repo, ours, theirs);
      expect(expected.conflicts).toEqual([]);
      const result = await mergeCommits(store, repo.rev(ours), repo.rev(theirs), { ours, theirs });
      expect(result.conflicts).toEqual([]);
      expect(result.tree).toBe(expected.tree);
      writeObjects(repo, result.objects);
      const merged = repo.raw(["show", `${result.tree}:lib/new-name.txt`]).stdout.toString();
      expect(merged).toContain("changed by the renamer;");
      expect(merged).toContain("changed by the editor;");
      // Without rename detection the same merge is a deletion conflict.
      const blind = await mergeCommits(store, repo.rev(ours), repo.rev(theirs), { renames: false });
      expect(blind.conflicts.map((conflict) => conflict.kind)).toEqual([
        "modify-delete",
        "modify-delete",
      ]);
    }

    // The same rename, but the two sides now change the same line: a conflict at the new name.
    repo.run("checkout", "-q", "-b", "clasher", base);
    const clash = [...lines];
    clash[2] = "changed by the clasher;";
    repo.write("src/old-name.txt", text(clash));
    repo.commit("edit the line the renamer edits");
    const store2 = loadStore(repo);
    const expected = mergeTree(repo, "renamer", "clasher");
    const result = await mergeCommits(store2, repo.rev("renamer"), repo.rev("clasher"), {
      ours: "renamer",
      theirs: "clasher",
    });
    expect(result.conflicts.map((conflict) => [conflict.path, conflict.kind])).toEqual([
      ["lib/new-name.txt", "content"],
    ]);
    expect(expected.conflicts).toEqual(["lib/new-name.txt"]);
    expect(result.tree).toBe(expected.tree);
  });

  it("names every kind of conflict and keeps what it says it keeps", async () => {
    const repo = new Repo("kinds");
    repo.write("content.txt", "one\ntwo\nthree\n");
    repo.write("deleted-here.txt", "a\nb\n");
    repo.write("binary.bin", new Uint8Array([0, 1, 2]));
    repo.write("mode.sh", "echo\n");
    repo.write("both-rename.txt", text(sourceFile(prng(5), 30)));
    repo.write("rename-delete.txt", text(sourceFile(prng(6), 30)));
    repo.symlink("content.txt", "link");
    const base = repo.commit("base");
    const moved = repo.raw(["show", "HEAD:both-rename.txt"]).stdout;
    const doomed = repo.raw(["show", "HEAD:rename-delete.txt"]).stdout;

    repo.run("checkout", "-q", "-b", "left");
    repo.write("content.txt", "one\nleft\nthree\n");
    repo.remove("deleted-here.txt");
    repo.write("binary.bin", new Uint8Array([0, 9, 9]));
    repo.write("added.txt", "left version\n");
    repo.symlink("mode.sh", "link");
    repo.remove("both-rename.txt");
    repo.write("left-name.txt", moved);
    repo.remove("rename-delete.txt");
    repo.write("survivor.txt", doomed);
    repo.write("spot", "a file on the left\n");
    repo.commit("left");

    repo.run("checkout", "-q", "-b", "right", base);
    repo.write("content.txt", "one\nright\nthree\n");
    repo.write("deleted-here.txt", "a\nb\nc\n");
    repo.write("binary.bin", new Uint8Array([0, 7, 7]));
    repo.write("added.txt", "right version\n");
    repo.symlink("binary.bin", "link");
    repo.remove("both-rename.txt");
    repo.write("right-name.txt", moved);
    repo.remove("rename-delete.txt");
    repo.write("spot/inside.txt", "a directory on the right\n");
    repo.commit("right");

    const store = loadStore(repo);
    const result = await mergeCommits(store, repo.rev("left"), repo.rev("right"), {
      ours: "left",
      theirs: "right",
    });
    const byPath = new Map(result.conflicts.map((conflict) => [conflict.path, conflict.kind]));
    expect(Object.fromEntries(byPath)).toEqual({
      "added.txt": "add-add",
      "binary.bin": "binary",
      "both-rename.txt": "rename-rename",
      "content.txt": "content",
      "deleted-here.txt": "modify-delete",
      "left-name.txt": "rename-rename",
      link: "symlink",
      "right-name.txt": "rename-rename",
      "spot~left": "file-directory",
      "survivor.txt": "rename-delete",
    });
    const expected = mergeTree(repo, "left", "right");
    expect([...byPath.keys()].sort()).toEqual([...expected.conflicts].sort());

    writeObjects(repo, result.objects);
    const show = (path: string): string =>
      repo.raw(["show", `${result.tree}:${path}`]).stdout.toString();
    expect(show("content.txt")).toBe(
      "one\n<<<<<<< left\nleft\n=======\nright\n>>>>>>> right\nthree\n",
    );
    expect(show("deleted-here.txt")).toBe("a\nb\nc\n");
    expect(show("spot~left")).toBe("a file on the left\n");
    expect(show("spot/inside.txt")).toBe("a directory on the right\n");
    expect(show("link")).toBe("mode.sh");
    expect(repo.lines("ls-tree", "--name-only", result.tree)).toContain("survivor.txt");
  });

  it("takes a side's tree untouched when the other side did nothing", async () => {
    const repo = new Repo("trivial");
    repo.write("a/b/c.txt", "c\n");
    repo.write("x.txt", "x\n");
    const base = repo.commit("base");
    repo.write("a/b/c.txt", "c changed\n");
    const tip = repo.commit("tip");
    const store = loadStore(repo);
    const result = await mergeTrees(store, repo.tree(base), repo.tree(base), repo.tree(tip));
    expect(result).toEqual({ tree: repo.tree(tip), conflicts: [], objects: [] });
    const same = await mergeTrees(store, repo.tree(base), repo.tree(tip), repo.tree(tip));
    expect(same.tree).toBe(repo.tree(tip));
    expect(same.objects).toEqual([]);
    // No common history at all: everything is an addition on both sides.
    const unrelated = await mergeTrees(store, null, repo.tree(base), repo.tree(tip));
    expect(unrelated.conflicts.map((conflict) => conflict.kind)).toEqual(["add-add"]);
  });

  it("refuses to merge a file over the text limit as text", async () => {
    const repo = new Repo("large");
    repo.write("big.txt", "line\n".repeat(400));
    const base = repo.commit("base");
    repo.run("checkout", "-q", "-b", "a");
    repo.write("big.txt", `first\n${"line\n".repeat(400)}`);
    repo.commit("a");
    repo.run("checkout", "-q", "-b", "b", base);
    repo.write("big.txt", `${"line\n".repeat(400)}last\n`);
    repo.commit("b");
    const store = loadStore(repo);
    const fine = await mergeCommits(store, repo.rev("a"), repo.rev("b"));
    expect(fine.conflicts).toEqual([]);
    const refused = await mergeCommits(store, repo.rev("a"), repo.rev("b"), {
      limits: { maxTextBytes: 1000 },
    });
    expect(refused.conflicts.map((conflict) => conflict.kind)).toEqual(["too-large"]);
  });

  it("merges a criss-cross history through a merged base", async () => {
    const repo = new Repo("criss-merge");
    const lines = sourceFile(prng(40), 60);
    repo.write("file.txt", text(lines));
    const root = repo.commit("root");
    repo.run("checkout", "-q", "-b", "left");
    lines[5] = "left edit one;";
    repo.write("file.txt", text(lines));
    const left1 = repo.commit("left 1");
    repo.run("checkout", "-q", "-b", "right", root);
    const rightLines = repo
      .raw(["show", `${root}:file.txt`])
      .stdout.toString()
      .split("\n");
    rightLines[40] = "right edit one;";
    repo.write("file.txt", rightLines.join("\n"));
    const right1 = repo.commit("right 1");
    repo.clock += 60;
    repo.run("merge", "-q", "--no-ff", "-m", "right takes left", left1);
    repo.run("checkout", "-q", "left");
    repo.clock += 60;
    repo.run("merge", "-q", "--no-ff", "-m", "left takes right", right1);
    const both = repo.raw(["show", "HEAD:file.txt"]).stdout.toString().split("\n");
    both[20] = "left edit two;";
    repo.write("file.txt", both.join("\n"));
    repo.commit("left 2");
    repo.run("checkout", "-q", "right");
    const both2 = repo.raw(["show", "HEAD:file.txt"]).stdout.toString().split("\n");
    both2[55] = "right edit two;";
    repo.write("file.txt", both2.join("\n"));
    repo.commit("right 2");

    const store = loadStore(repo);
    const expected = mergeTree(repo, "left", "right");
    const result = await mergeCommits(store, repo.rev("left"), repo.rev("right"));
    expect(result.bases).toHaveLength(2);
    expect(result.conflicts).toEqual([]);
    expect(result.tree).toBe(expected.tree);
  });
});

describeGit("merge strategies", () => {
  const people = () => {
    const author = signature({
      name: "Mona Merger",
      email: "mona@example.com",
      timestamp: 1_700_100_000,
    });
    return { author, committer: author };
  };

  function setup(): { repo: Repo; base: string; target: string; source: string } {
    const repo = new Repo("strategies");
    const next = prng(606);
    const files = new Map<string, string[]>();
    for (let i = 0; i < 5; i++) {
      files.set(`src/f${i}.txt`, sourceFile(next, 50));
      repo.write(`src/f${i}.txt`, text(files.get(`src/f${i}.txt`)!));
    }
    const base = repo.commit("base");
    repo.run("checkout", "-q", "-b", "feature");
    for (let k = 0; k < 4; k++) {
      const lines = files.get(`src/f${k % 2}.txt`)!;
      lines[3 + k * 9] = `feature line ${k};`;
      repo.write(`src/f${k % 2}.txt`, text(lines));
      if (k === 2) repo.write("src/feature-only.txt", "new in the feature\n");
      repo.commit(`feature ${k}\n\nBody of feature commit ${k}.`);
    }
    const source = repo.rev("HEAD");
    repo.run("checkout", "-q", "main");
    for (let k = 0; k < 2; k++) {
      const lines = files.get(`src/f${3 + k}.txt`)!;
      lines[10] = `main line ${k};`;
      repo.write(`src/f${3 + k}.txt`, text(lines));
      repo.commit(`main ${k}`);
    }
    return { repo, base, target: repo.rev("HEAD"), source };
  }

  function merged(outcome: MergeOutcome): Extract<MergeOutcome, { status: "merged" }> {
    expect(outcome.status).toBe("merged");
    return outcome as Extract<MergeOutcome, { status: "merged" }>;
  }

  it("makes the merge commit git makes", async () => {
    const { repo, target, source } = setup();
    const store = loadStore(repo);
    const message = normalizeMessage("Merge feature into main  \n\n\n\nReviewed.\n\n");
    expect(message).toBe("Merge feature into main\n\nReviewed.\n");
    const outcome = merged(await mergeWithCommit(store, target, source, { ...people(), message }));
    writeObjects(repo, outcome.objects);
    // The commit is last, after everything it needs.
    expect(outcome.objects.at(-1)!.type).toBe("commit");
    expect(outcome.objects.at(-1)!.oid).toBe(outcome.commit);
    expect(repo.run("log", "-1", "--format=%P|%an|%ae|%at|%s|%b", outcome.commit)).toBe(
      `${target} ${source}|Mona Merger|mona@example.com|1700100000|Merge feature into main|Reviewed.\n`,
    );
    repo.clock += 100;
    repo.run("merge", "-q", "--no-ff", "-m", "git's merge", source);
    expect(outcome.tree).toBe(repo.tree("HEAD"));
    repo.run("fsck", "--strict", "--no-dangling");
  });

  it("detects a fast-forward and an up-to-date target", async () => {
    const { repo, base, target, source } = setup();
    const store = loadStore(repo);
    expect(await analyzeMerge(store, base, source)).toMatchObject({
      fastForward: true,
      upToDate: false,
    });
    expect(await analyzeMerge(store, source, base)).toMatchObject({
      fastForward: false,
      upToDate: true,
    });
    expect(await analyzeMerge(store, target, source)).toMatchObject({
      fastForward: false,
      upToDate: false,
      bases: [base],
    });
    const input = { ...people(), message: "m\n" };
    expect(await mergeWithCommit(store, base, source, input, { fastForward: "allow" })).toEqual({
      status: "fast-forward",
      commit: source,
    });
    expect(await mergeWithCommit(store, source, base, input)).toEqual({
      status: "up-to-date",
      commit: source,
    });
    // By default a forge still makes a merge commit where it could have fast-forwarded.
    const forced = merged(await mergeWithCommit(store, base, source, input));
    expect(forced.tree).toBe(repo.tree(source));
    expect(forced.objects.map((object) => object.type)).toEqual(["commit"]);
  });

  it("squashes to one commit with the merged tree", async () => {
    const { repo, target, source } = setup();
    const store = loadStore(repo);
    const outcome = merged(
      await squashMerge(store, target, source, { ...people(), message: "Feature (#1)\n" }),
    );
    writeObjects(repo, outcome.objects);
    expect(repo.run("log", "-1", "--format=%P|%s", outcome.commit)).toBe(`${target}|Feature (#1)`);
    repo.run("merge", "-q", "--squash", source);
    repo.commit("git's squash");
    expect(outcome.tree).toBe(repo.tree("HEAD"));
  });

  it("tells a merged, squashed or cherry-picked source from one that is not in", async () => {
    const { repo, base, target, source } = setup();
    let store = loadStore(repo);
    expect(await landedIn(store, target, source)).toBeNull();
    // A branch with nothing of its own is an ancestor; the caller decides whether it counts.
    expect(await landedIn(store, target, base)).toBe("contained");

    // Squashed, then main moves on elsewhere: everything it changes is in.
    repo.run("merge", "-q", "--squash", source);
    repo.commit("Feature, squashed");
    const other = repo.lines("show", `${target}:src/f4.txt`);
    other[30] = "main after the squash;";
    repo.write("src/f4.txt", text(other));
    const squashed = repo.commit("main after the squash");
    store = loadStore(repo);
    expect(await landedIn(store, squashed, source)).toBe("applied");

    // A merge commit has the source in its history.
    repo.run("checkout", "-q", "-b", "merged", target);
    repo.run("merge", "-q", "--no-ff", "-m", "merge", source);
    store = loadStore(repo);
    expect(await landedIn(store, repo.rev("HEAD"), source)).toBe("contained");

    // Only some of its commits picked: not in.
    repo.run("checkout", "-q", "-b", "partial", target);
    repo.run("cherry-pick", repo.rev(`${source}~3`));
    store = loadStore(repo);
    expect(await landedIn(store, repo.rev("HEAD"), source)).toBeNull();
  });

  it("does not take a source that changes nothing, or one main has changed again, as applied", async () => {
    const { repo, target, source } = setup();
    // Lands as a squash, then main edits a line the feature wrote: merging it again conflicts.
    repo.run("merge", "-q", "--squash", source);
    repo.commit("Feature, squashed");
    const edited = repo.lines("show", "HEAD:src/f0.txt");
    edited[3] = "main rewrote the feature's line;";
    repo.write("src/f0.txt", text(edited));
    const rewritten = repo.commit("rewrite a feature line");

    // A branch whose commits cancel out.
    repo.run("checkout", "-q", "-b", "nothing", target);
    repo.write("src/f2.txt", "changed\n");
    repo.commit("change");
    repo.run("revert", "--no-edit", "HEAD");
    const nothing = repo.rev("HEAD");

    const store = loadStore(repo);
    expect(await landedIn(store, rewritten, source)).toBeNull();
    expect(await landedIn(store, target, nothing)).toBeNull();
  });

  it("rebases the way git rebase does", async () => {
    const { repo, target, source } = setup();
    const store = loadStore(repo);
    const committer = signature({
      name: "Rita Rebaser",
      email: "rita@example.com",
      timestamp: 1_700_200_000,
    });
    const outcome = await rebaseMerge(store, target, source, committer);
    const done = merged(outcome);
    writeObjects(repo, done.objects);
    repo.run("checkout", "-q", "-b", "rebased", source);
    repo.clock += 500;
    repo.run("rebase", "-q", target);
    const ours = repo.lines("log", "--format=%T|%an|%ae|%at|%B%x00", `${target}..${done.commit}`);
    const theirs = repo.lines("log", "--format=%T|%an|%ae|%at|%B%x00", `${target}..rebased`);
    expect(ours).toEqual(theirs);
    expect(repo.lines("log", "--format=%cn|%ct", `${target}..${done.commit}`)).toEqual(
      Array(4).fill("Rita Rebaser|1700200000"),
    );
    expect(outcome.rewritten!.size).toBe(4);
    expect(repo.run("rev-parse", `${done.commit}~4`)).toBe(target);
    repo.run("fsck", "--strict", "--no-dangling");
  });

  it("fast-forwards a rebase that has nothing to replay, and drops what the target already has", async () => {
    const { repo, base, target, source } = setup();
    const committer = people().committer;
    let store = loadStore(repo);
    expect(await rebaseMerge(store, base, source, committer)).toMatchObject({
      status: "fast-forward",
      commit: source,
    });
    expect(await rebaseMerge(store, source, base, committer)).toMatchObject({
      status: "up-to-date",
    });
    const rewritten = await rebaseMerge(store, base, source, committer, { reuseUnchanged: false });
    expect(rewritten.status).toBe("merged");

    // The target cherry-picks the feature's first commit; rebasing must not replay it.
    const first = repo.lines("rev-list", "--reverse", `${base}..${source}`)[0]!;
    repo.run("checkout", "-q", "main");
    repo.clock += 50;
    repo.run("cherry-pick", first);
    const picked = repo.rev("HEAD");
    expect(picked).not.toBe(target);
    store = loadStore(repo);
    const outcome = merged(await rebaseMerge(store, picked, source, committer));
    writeObjects(repo, outcome.objects);
    expect(repo.lines("rev-list", `${picked}..${outcome.commit}`)).toHaveLength(3);
    repo.run("checkout", "-q", "-b", "rebased2", source);
    repo.run("rebase", "-q", picked);
    expect(outcome.tree).toBe(repo.tree("HEAD"));
  });

  it("stops at the commit that conflicts", async () => {
    const repo = new Repo("rebase-conflict");
    repo.write("f.txt", "one\ntwo\nthree\n");
    const base = repo.commit("base");
    repo.run("checkout", "-q", "-b", "feature");
    repo.write("other.txt", "fine\n");
    const fine = repo.commit("fine");
    repo.write("f.txt", "one\nfeature\nthree\n");
    const bad = repo.commit("clashes");
    repo.write("third.txt", "never reached\n");
    const tip = repo.commit("after");
    repo.run("checkout", "-q", "main");
    repo.write("f.txt", "one\nmain\nthree\n");
    const target = repo.commit("main change");
    const store = loadStore(repo);
    const committer = people().committer;

    const outcome = await rebaseMerge(store, target, tip, committer);
    expect(outcome.status).toBe("conflicts");
    if (outcome.status !== "conflicts") return;
    expect(outcome.stoppedAt).toBe(bad);
    expect(outcome.conflicts.map((conflict) => conflict.path)).toEqual(["f.txt"]);
    expect(outcome.rewritten!.has(fine)).toBe(true);
    writeObjects(repo, outcome.objects);
    expect(repo.raw(["show", `${outcome.tree}:f.txt`]).stdout.toString()).toBe(
      `one\n<<<<<<< HEAD\nmain\n=======\nfeature\n>>>>>>> ${bad.slice(0, 7)} (clashes)\nthree\n`,
    );
    for (const run of [mergeWithCommit, squashMerge]) {
      const result = await run(store, target, tip, { ...people(), message: "m\n" });
      expect(result.status).toBe("conflicts");
    }
    await expect(
      rebaseMerge(store, target, tip, committer, { maxCommits: 2 }),
    ).rejects.toMatchObject({ code: "limit" });
    expect(base).not.toBe(target);
  });

  it("builds commits git accepts", () => {
    const repo = new Repo("commit");
    repo.write("a.txt", "a\n");
    const head = repo.commit("first");
    const who = signature({
      name: " Odd <Name>. ",
      email: "<odd@example.com>",
      timestamp: 5,
      timezoneOffset: -150,
    });
    expect(who).toMatchObject({ name: "Odd Name", email: "odd@example.com" });
    const commit = createCommit({
      tree: repo.tree(head),
      parents: [head],
      author: who,
      committer: who,
      message: normalizeMessage("\n\nsubject  \r\n\r\n\r\nbody\r\n"),
    });
    writeObjects(repo, [commit]);
    expect(repo.run("log", "-1", "--format=%an|%ae|%ad|%s|%b", "--date=raw", commit.oid)).toBe(
      "Odd Name|odd@example.com|5 -0230|subject|body\n",
    );
    repo.run("fsck", "--strict", "--no-dangling");
    expect(() => signature({ name: " <> ", email: "x@example.com" })).toThrow();
  });
});
