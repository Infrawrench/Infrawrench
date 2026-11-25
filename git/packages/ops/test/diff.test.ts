import { afterAll, beforeAll, expect, it } from "vitest";
import { type MemoryObjectStore, collectBytes, decodeText } from "@infrawrench/git-core";
import {
  type DiffOptions,
  diffCommit,
  diffTreeFiles,
  diffTrees,
  formatPatch,
  isBinary,
  patchStream,
  quotePath,
} from "../src";
import {
  type HistoryFixture,
  Repo,
  cleanupTempDirs,
  describeGit,
  editLines,
  loadStore,
  makeHistory,
  prng,
  sourceFile,
  text,
} from "./helpers";

afterAll(cleanupTempDirs);

const STATUS: Record<string, string> = {
  added: "A",
  deleted: "D",
  modified: "M",
  "type-changed": "T",
  renamed: "R",
  copied: "C",
};

/** Our changes in the shape of `git diff --name-status`: `M\tpath`, `R087\told\tnew`. */
async function nameStatus(
  store: MemoryObjectStore,
  a: string,
  b: string,
  options: DiffOptions = {},
): Promise<string[]> {
  const { changes } = await diffTreeFiles(store, a, b, options);
  return changes.map((change) => {
    const letter = STATUS[change.status]!;
    if (change.status === "renamed" || change.status === "copied") {
      const score = String(change.similarity).padStart(3, "0");
      return `${letter}${score}\t${change.oldPath}\t${change.newPath}`;
    }
    return `${letter}\t${change.newPath ?? change.oldPath}`;
  });
}

/** Our diff in the shape of `git diff --numstat -z`-free output with renames spelled `old => new` avoided. */
async function numstat(
  store: MemoryObjectStore,
  a: string,
  b: string,
  options: DiffOptions = {},
): Promise<string[]> {
  const result = await diffTrees(store, a, b, { renames: false, ...options });
  return (
    result.files
      // With whitespace ignored git leaves out a file whose changes all vanish.
      .filter(
        (file) => file.binary || file.additions + file.deletions > 0 || !options.ignoreWhitespace,
      )
      .map((file) =>
        file.binary
          ? `-\t-\t${file.newPath ?? file.oldPath}`
          : `${file.additions}\t${file.deletions}\t${file.newPath ?? file.oldPath}`,
      )
  );
}

async function patchText(
  store: MemoryObjectStore,
  a: string | null,
  b: string | null,
  options: DiffOptions = {},
): Promise<string> {
  return decodeText(await collectBytes(patchStream(store, a, b, options)));
}

describeGit("diff against git over a random history", () => {
  let fixture: HistoryFixture;
  let store: MemoryObjectStore;
  let pairs: Array<[string, string]>;

  beforeAll(() => {
    fixture = makeHistory(21, 120);
    store = loadStore(fixture.repo);
    const { commits } = fixture;
    const next = prng(4);
    pairs = [];
    // Each commit against its predecessor in the list, and some pairs far apart.
    for (let i = 1; i < commits.length; i++) pairs.push([commits[i - 1]!, commits[i]!]);
    for (let i = 0; i < 40; i++) {
      pairs.push([commits[next() % commits.length]!, commits[next() % commits.length]!]);
    }
  });

  it("names and statuses match git diff --name-status -M", async () => {
    const { repo } = fixture;
    let renames = 0;
    for (const [a, b] of pairs) {
      const expected = repo.lines("diff", "--name-status", "-M", "-l0", a, b);
      const ours = await nameStatus(store, repo.tree(a), repo.tree(b), {
        limits: { renameLimit: 100_000 },
      });
      expect(ours, `${a} ${b}`).toEqual(expected);
      renames += ours.filter((line) => line.startsWith("R")).length;
      expect(await nameStatus(store, repo.tree(a), repo.tree(b), { renames: false })).toEqual(
        repo.lines("diff", "--name-status", "--no-renames", a, b),
      );
    }
    expect(renames).toBeGreaterThan(10);
  });

  it("line counts match git diff --numstat", async () => {
    const { repo } = fixture;
    for (const [a, b] of pairs) {
      expect(await numstat(store, repo.tree(a), repo.tree(b)), `${a} ${b}`).toEqual(
        repo.lines("diff", "--numstat", "--no-renames", a, b),
      );
    }
  });

  it("patch text is git diff --full-index byte for byte", async () => {
    const { repo } = fixture;
    for (const [a, b] of pairs) {
      const expected = repo.raw(["diff", "--full-index", "-M", "-l0", a, b]).stdout.toString();
      const ours = await patchText(store, repo.tree(a), repo.tree(b), {
        limits: { renameLimit: 100_000 },
      });
      expect(ours, `${a} ${b}`).toBe(expected);
    }
  });

  it("other context sizes, histogram and whitespace options match too", async () => {
    const { repo } = fixture;
    for (const [a, b] of pairs.slice(-40)) {
      const trees = [repo.tree(a), repo.tree(b)] as const;
      const raw = (...flags: string[]): string =>
        repo.raw(["diff", "--full-index", "--no-renames", ...flags, a, b]).stdout.toString();
      const base = { renames: false } as const;
      expect(await patchText(store, ...trees, { ...base, context: 0 })).toBe(raw("-U0"));
      expect(await patchText(store, ...trees, { ...base, context: 10 })).toBe(raw("-U10"));
      expect(await patchText(store, ...trees, { ...base, context: 1, interHunkContext: 4 })).toBe(
        raw("-U1", "--inter-hunk-context=4"),
      );
      expect(await patchText(store, ...trees, { ...base, algorithm: "histogram" })).toBe(
        raw("--histogram"),
      );
      expect(await patchText(store, ...trees, { ...base, indentHeuristic: false })).toBe(
        raw("--no-indent-heuristic"),
      );
    }
  });

  it("the structured result carries git's line numbers", async () => {
    const { repo } = fixture;
    for (const [a, b] of pairs.slice(0, 60)) {
      const result = await diffTrees(store, repo.tree(a), repo.tree(b), { renames: false });
      const expected = repo.raw(["diff", "-U3", "--no-renames", a, b]).stdout.toString();
      const headers = expected.split("\n").filter((line) => line.startsWith("@@ "));
      expect(result.files.flatMap((file) => file.hunks.map((hunk) => hunk.header))).toEqual(
        headers,
      );
      for (const file of result.files) {
        for (const hunk of file.hunks) {
          let oldNumber = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
          let newNumber = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
          for (const line of hunk.lines) {
            if (line.kind !== "add") expect(line.oldNumber).toBe(oldNumber++);
            else expect(line.oldNumber).toBeNull();
            if (line.kind !== "delete") expect(line.newNumber).toBe(newNumber++);
            else expect(line.newNumber).toBeNull();
          }
          expect(hunk.lines.filter((line) => line.kind !== "add")).toHaveLength(hunk.oldLines);
          expect(hunk.lines.filter((line) => line.kind !== "delete")).toHaveLength(hunk.newLines);
        }
      }
      const totals = repo.lines("diff", "--numstat", "--no-renames", a, b).reduce(
        (sum, line) => {
          const [added, deleted] = line.split("\t");
          return [sum[0]! + Number(added), sum[1]! + Number(deleted)];
        },
        [0, 0],
      );
      expect([result.additions, result.deletions]).toEqual(totals);
    }
  });
});

describeGit("diff special cases", () => {
  it("handles modes, symlinks, binary, empty files, missing newlines and odd names", async () => {
    const repo = new Repo("special");
    const next = prng(8);
    const body = sourceFile(next, 40);
    repo.write("plain.txt", text(body));
    repo.write("no-newline.txt", "one\ntwo\nthree");
    repo.write("gains-newline.txt", "one\ntwo");
    repo.write("script.sh", "#!/bin/sh\necho hi\n");
    repo.write("binary.bin", new Uint8Array([1, 2, 0, 3, 4, 5]));
    repo.write("to-empty.txt", "was here\n");
    repo.write("with space.txt", "spaced\n");
    repo.write("café/naïve.txt", "accented\n");
    repo.write('quo"te.txt', "quoted\n");
    repo.write("becomes-link.txt", "a file\n");
    repo.write("crlf.txt", "one\r\ntwo\r\nthree\r\n");
    repo.symlink("plain.txt", "link");
    repo.write("gone/deep/file.txt", "deleted later\n");
    const first = repo.commit("first");

    editLines(body, next, 3);
    repo.write("plain.txt", text(body));
    repo.write("no-newline.txt", "one\n2\nthree");
    repo.write("gains-newline.txt", "one\ntwo\n");
    repo.chmod("script.sh", 0o755);
    repo.write("binary.bin", new Uint8Array([1, 2, 0, 9, 9, 9, 9]));
    repo.write("to-empty.txt", "");
    repo.write("new-empty.txt", "");
    repo.write("with space.txt", "spaced out\n");
    repo.write("café/naïve.txt", "accented more\n");
    repo.write('quo"te.txt', "quoted again\n");
    repo.remove("becomes-link.txt");
    repo.symlink("plain.txt", "becomes-link.txt");
    repo.write("crlf.txt", "one\r\n2\r\nthree\r\n");
    repo.symlink("script.sh", "link");
    repo.remove("gone");
    repo.write("new/dir/added.txt", "brand new\nfile\n");
    const second = repo.commit("second");
    const store = loadStore(repo);
    const trees = [repo.tree(first), repo.tree(second)] as const;

    // Git quotes a name with a quote in it even in this listing; the patch below covers that one.
    const unquoted = (lines: string[]): string[] => lines.filter((line) => !line.includes("quo"));
    expect(unquoted(await nameStatus(store, ...trees))).toEqual(
      unquoted(
        repo.lines("-c", "core.quotePath=false", "diff", "--name-status", "-M", first, second),
      ),
    );
    for (const flags of [["-M"], ["-M", "-U0"]]) {
      const expected = repo.raw(["diff", "--full-index", ...flags, first, second]).stdout;
      const ours = await patchText(store, ...trees, {
        ...(flags.includes("-U0") ? { context: 0 } : {}),
      });
      expect(ours).toBe(expected.toString());
    }
    // And backwards, where the additions are deletions and the type change runs the other way.
    expect(await patchText(store, trees[1], trees[0])).toBe(
      repo.raw(["diff", "--full-index", "-M", second, first]).stdout.toString(),
    );
    // From nothing and to nothing: every file added, every file deleted.
    const empty = repo.run("hash-object", "-t", "tree", "/dev/null");
    expect(await patchText(store, null, trees[1])).toBe(
      repo.raw(["diff", "--full-index", empty, second]).stdout.toString(),
    );
    expect(await patchText(store, trees[1], null)).toBe(
      repo.raw(["diff", "--full-index", second, empty]).stdout.toString(),
    );

    const result = await diffCommit(store, second);
    const binary = result.files.find((file) => file.newPath === "binary.bin")!;
    expect(binary.binary).toBe(true);
    expect(binary.hunks).toEqual([]);
    const noNewline = result.files.find((file) => file.newPath === "no-newline.txt")!;
    // The unchanged last line has no newline on either side; it is shown once, as context.
    expect(noNewline.hunks[0]!.lines.filter((line) => line.noNewline)).toEqual([
      { kind: "context", oldNumber: 3, newNumber: 3, text: "three", noNewline: true },
    ]);
    const gains = result.files.find((file) => file.newPath === "gains-newline.txt")!;
    expect(gains.hunks[0]!.lines.slice(-2)).toEqual([
      { kind: "delete", oldNumber: 2, newNumber: null, text: "two", noNewline: true },
      { kind: "add", oldNumber: null, newNumber: 2, text: "two" },
    ]);
    expect(result.files.find((file) => file.newPath === "becomes-link.txt")!.status).toBe(
      "type-changed",
    );
    expect(isBinary(new Uint8Array(9000).fill(65))).toBe(false);
    expect(quotePath("a\tb")).toBe('"a\\tb"');
  });

  it("ignores whitespace the way -w, -b and --ignore-space-at-eol do", async () => {
    const repo = new Repo("space");
    const next = prng(31);
    const files: string[][] = [];
    for (let i = 0; i < 6; i++) {
      files.push(sourceFile(next, 50));
      repo.write(`f${i}.txt`, text(files[i]!));
    }
    const first = repo.commit("first");
    files.forEach((lines, i) => {
      for (let k = 0; k < lines.length; k++) {
        const roll = next() % 9;
        if (roll === 0) lines[k] = `${lines[k]}   `;
        else if (roll === 1) lines[k] = lines[k]!.replace(/ /g, "  ");
        else if (roll === 2) lines[k] = `\t${lines[k]!.trimStart()}`;
        else if (roll === 3) lines[k] = lines[k]!.replace(/ /g, "");
      }
      editLines(lines, next, 2);
      repo.write(`f${i}.txt`, text(lines));
    });
    const second = repo.commit("second");
    const store = loadStore(repo);
    const trees = [repo.tree(first), repo.tree(second)] as const;
    const cases = [
      ["-w", "all"],
      ["-b", "change"],
      ["--ignore-space-at-eol", "eol"],
    ] as const;
    for (const [flag, mode] of cases) {
      expect(await numstat(store, ...trees, { ignoreWhitespace: mode }), flag).toEqual(
        repo.lines("diff", "--numstat", flag, first, second),
      );
      const expected = repo.raw(["diff", "--full-index", flag, first, second]).stdout.toString();
      const ours = await patchText(store, ...trees, { ignoreWhitespace: mode });
      // Git prints no header at all for a file whose changes all vanish; ours prints the header.
      const hunks = (patch: string): string[] =>
        patch.split("\n").filter((line) => /^[-+ @]/.test(line) && !/^(---|\+\+\+) /.test(line));
      expect(hunks(ours), flag).toEqual(hunks(expected));
    }
  });
});

describeGit("rename detection", () => {
  it("matches git on a scripted set of renames", async () => {
    const repo = new Repo("renames");
    const next = prng(77);
    const make = (lines: number): string[] => sourceFile(next, lines);
    const files = new Map<string, string[]>();
    const put = (path: string, lines: string[]): void => {
      files.set(path, lines);
      repo.write(path, text(lines));
    };
    put("exact/a.txt", make(40));
    put("exact/b.txt", make(40));
    // Two identical files: which one a destination pairs with is decided by name.
    put("twins/one.txt", make(30));
    repo.write("twins/two.txt", text(files.get("twins/one.txt")!));
    put("edit/small-change.txt", make(80));
    put("edit/half-change.txt", make(80));
    put("edit/mostly-new.txt", make(80));
    put("basename/keep-name.txt", make(60));
    put("crowd/c1.txt", make(50));
    put("crowd/c2.txt", make(50));
    put("crowd/c3.txt", make(50));
    put("stays.txt", make(20));
    repo.write(
      "bin/data.bin",
      new Uint8Array(4000).map((_, i) => (i * 7) % 251),
    );
    repo.symlink("stays.txt", "old-link");
    const first = repo.commit("first");

    const move = (from: string, to: string, change: (lines: string[]) => void = () => {}) => {
      const lines = [...files.get(from)!];
      repo.remove(from);
      change(lines);
      repo.write(to, text(lines));
    };
    const rewrite = (share: number) => (lines: string[]) => {
      const count = Math.floor(lines.length * share);
      for (let i = 0; i < count; i++) lines[i] = `rewritten ${i} ${next()}`;
    };
    move("exact/a.txt", "moved/a.txt");
    move("exact/b.txt", "moved/renamed-b.txt");
    move("twins/one.txt", "elsewhere/two.txt");
    repo.remove("twins/two.txt");
    repo.write("elsewhere/one.txt", text(files.get("twins/one.txt")!));
    move("edit/small-change.txt", "edited/small.txt", rewrite(0.1));
    move("edit/half-change.txt", "edited/half.txt", rewrite(0.45));
    move("edit/mostly-new.txt", "edited/mostly.txt", rewrite(0.8));
    move("basename/keep-name.txt", "other/place/keep-name.txt", rewrite(0.2));
    move("crowd/c1.txt", "crowd2/x.txt", rewrite(0.3));
    move("crowd/c2.txt", "crowd2/y.txt", rewrite(0.3));
    move("crowd/c3.txt", "crowd2/z.txt", rewrite(0.3));
    repo.remove("bin/data.bin");
    repo.write(
      "bin2/data2.bin",
      new Uint8Array(4000).map((_, i) => (i < 300 ? 0 : (i * 7) % 251)),
    );
    repo.remove("old-link");
    repo.symlink("stays.txt", "new-link");
    repo.write("unrelated.txt", text(make(40)));
    const second = repo.commit("second");

    const store = loadStore(repo);
    const trees = [repo.tree(first), repo.tree(second)] as const;
    const ours = await nameStatus(store, ...trees);
    expect(ours).toEqual(repo.lines("diff", "--name-status", "-M", first, second));
    expect(ours.filter((line) => line.startsWith("R100"))).toHaveLength(5);
    expect(ours).toContain("A\tedited/mostly.txt");
    expect(await patchText(store, ...trees)).toBe(
      repo.raw(["diff", "--full-index", "-M", first, second]).stdout.toString(),
    );
    // Other thresholds, and the limit that turns inexact detection off.
    for (const percent of [30, 70, 90]) {
      expect(await nameStatus(store, ...trees, { threshold: percent / 100 }), `${percent}`).toEqual(
        repo.lines("diff", "--name-status", `-M${percent}%`, first, second),
      );
    }
    expect(await nameStatus(store, ...trees, { limits: { renameLimit: 1 } })).toEqual(
      repo.lines("diff", "--name-status", "-M", "-l1", first, second),
    );
    expect(await nameStatus(store, ...trees, { threshold: 1 })).toEqual(
      repo.lines("diff", "--name-status", "-M100%", first, second),
    );
  });

  it("finds copies the way -C does", async () => {
    const repo = new Repo("copies");
    const next = prng(13);
    const lines = sourceFile(next, 60);
    repo.write("origin.txt", text(lines));
    repo.write("removed.txt", text(sourceFile(next, 50)));
    const first = repo.commit("first");
    const copy = [...lines];
    copy.splice(5, 3, "something else;", "entirely;");
    repo.write("copy.txt", text(copy));
    lines.push("a new last line;");
    repo.write("origin.txt", text(lines));
    const gone = repo.raw(["show", "HEAD:removed.txt"]).stdout.toString();
    repo.remove("removed.txt");
    repo.write("twice-1.txt", gone);
    repo.write("twice-2.txt", gone);
    const second = repo.commit("second");
    const store = loadStore(repo);
    const trees = [repo.tree(first), repo.tree(second)] as const;
    expect(await nameStatus(store, ...trees, { copies: true })).toEqual(
      repo.lines("diff", "--name-status", "-C", first, second),
    );
    expect(await patchText(store, ...trees, { copies: true })).toBe(
      repo.raw(["diff", "--full-index", "-C", first, second]).stdout.toString(),
    );
  });
});

describeGit("patch downloads and limits", () => {
  it("writes a patch git am applies", async () => {
    const repo = new Repo("patch");
    const next = prng(2);
    const lines = sourceFile(next, 40);
    repo.write("a.txt", text(lines));
    repo.write("b.txt", "b\n");
    const base = repo.commit("base");
    editLines(lines, next, 3);
    repo.write("a.txt", text(lines));
    repo.remove("b.txt");
    repo.write("dir/c.txt", "c\nd\n");
    const tip = repo.commit("Change three files\n\nWith a body that says why.\nOn two lines.");
    const store = loadStore(repo);

    const patch = await formatPatch(store, tip, { signature: "test" });
    const textPatch = decodeText(patch);
    expect(textPatch).toMatch(new RegExp(`^From ${tip} Mon Sep 17 00:00:00 2001\n`));
    expect(textPatch).toContain("From: Ada Author <ada@example.com>\n");
    expect(textPatch).toContain("Subject: [PATCH] Change three files\n\nWith a body");
    expect(textPatch).toContain(" 3 files changed, ");
    // The header lines git writes for the same commit, apart from its abbreviations.
    const theirs = repo.raw(["format-patch", "-1", "--stdout", "--full-index", tip]).stdout;
    const head = (value: string): string[] => value.split("\n---\n")[0]!.split("\n");
    expect(head(textPatch)).toEqual(head(theirs.toString()));
    const numbers = (value: string): string => value.match(/\d+ files? changed.*/)![0];
    expect(numbers(textPatch)).toBe(numbers(theirs.toString()));

    repo.run("checkout", "-q", "-b", "apply", base);
    repo.clock += 5;
    repo.raw(["am", "-q"], { input: patch });
    expect(repo.tree("HEAD")).toBe(repo.tree(tip));
    expect(repo.run("log", "-1", "--format=%an|%s|%b")).toBe(
      "Ada Author|Change three files|With a body that says why.\nOn two lines.\n",
    );
  });

  it("reports what it would not diff instead of diffing it", async () => {
    const repo = new Repo("limits");
    for (let i = 0; i < 6; i++) repo.write(`f${i}.txt`, `line ${i}\n`);
    repo.write("big.txt", "x\n".repeat(3000));
    const first = repo.commit("first");
    for (let i = 0; i < 6; i++) repo.write(`f${i}.txt`, `line ${i} changed\n`);
    repo.write("big.txt", "y\n".repeat(3000));
    const second = repo.commit("second");
    const store = loadStore(repo);
    const trees = [repo.tree(first), repo.tree(second)] as const;

    const tooLarge = await diffTrees(store, ...trees, { limits: { maxTextBytes: 1000 } });
    const big = tooLarge.files.find((file) => file.newPath === "big.txt")!;
    expect(big.tooLarge).toBe(true);
    expect(big.hunks).toEqual([]);

    const fewFiles = await diffTrees(store, ...trees, { limits: { maxDiffFiles: 3 } });
    expect(fewFiles.files).toHaveLength(7);
    expect(fewFiles.files.filter((file) => file.skipped)).toHaveLength(4);

    const fewEntries = await diffTrees(store, ...trees, { limits: { maxDiffEntries: 2 } });
    expect(fewEntries.truncated).toBe(true);
    expect(fewEntries.files).toHaveLength(2);
  });
});
