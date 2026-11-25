import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GitError,
  type TreeEntry,
  buildTree,
  commitHeader,
  compareTreeEntries,
  formatSignature,
  hashObjectSync,
  isSortedTree,
  messageSubject,
  normalizeTreeMode,
  parseCommit,
  parseSignature,
  parseTag,
  parseTree,
  serializeCommit,
  serializeTag,
  serializeTree,
  sortTreeEntries,
} from "../src";
import {
  catFileBatch,
  cleanupTempDirs,
  git,
  gitRaw,
  listObjects,
  makeFixtureRepo,
} from "./helpers";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const latin1 = (value: string): Uint8Array => Uint8Array.from(value, (c) => c.charCodeAt(0));

afterAll(cleanupTempDirs);

describe("signatures", () => {
  it("parses and formats the usual shape", () => {
    const signature = parseSignature("Ada Lovelace <ada@example.com> 1700000000 +0100");
    expect(signature).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
      timestamp: 1700000000,
      timezoneOffset: 60,
    });
    expect(formatSignature(signature)).toBe("Ada Lovelace <ada@example.com> 1700000000 +0100");
  });

  it("keeps odd timezones", () => {
    for (const zone of ["-0000", "+0000", "+0530", "-0930", "+1245", "+1400", "-1200", "+2359"]) {
      const line = `A <a@b> 1 ${zone}`;
      const parsed = parseSignature(line);
      expect(parsed.raw).toBeUndefined();
      expect(formatSignature(parsed)).toBe(line);
    }
    expect(Object.is(parseSignature("A <a@b> 1 -0000").timezoneOffset, -0)).toBe(true);
    expect(parseSignature("A <a@b> 1 -0930").timezoneOffset).toBe(-570);
  });

  it("round-trips lines that are not in the usual shape", () => {
    const odd = [
      "A <a@b> 1 +051800",
      "A <a@b> 1 +100",
      "A <a@b> 1 0000",
      "A <a@b> 1 +0199",
      "A <a@b>  1  +0000",
      "A <a@b> 1",
      "A <a@b>",
      "<a@b> 1 +0000",
      " <a@b> 1 +0000",
      "A  <a@b> 1 +0000",
      "no email at all",
      "A <a@b> 99999999999999999999 +0000",
      "A <a@b> -5 +0000",
      "A <a <nested>@b> 1 +0000",
      "",
    ];
    for (const line of odd) {
      const parsed = parseSignature(line);
      expect(formatSignature(parsed)).toBe(line);
    }
    expect(parseSignature("A <a@b> 1 +0199").timezoneOffset).toBe(159);
    expect(parseSignature("no email at all").name).toBe("no email at all");
  });

  it("drops a stale raw line once a field changes", () => {
    const parsed = parseSignature("A <a@b> 1 +100");
    expect(parsed.raw).toBe("A <a@b> 1 +100");
    expect(formatSignature({ ...parsed, name: "B" })).toBe("B <a@b> 1 +0100");
  });
});

describe("commits", () => {
  const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const parent = "ce013625030ba8dba906f756967f9e9ca394464a";
  const roundTrip = (source: string): void => {
    const bytes = text(source);
    expect(Buffer.compare(serializeCommit(parseCommit(bytes)), bytes)).toBe(0);
  };

  it("parses the fields", () => {
    const commit = parseCommit(
      text(
        `tree ${tree}\nparent ${parent}\nparent ${tree}\nauthor A <a@b> 1 +0000\ncommitter C <c@d> 2 -0500\n\nsubject\n\nbody\n`,
      ),
    );
    expect(commit.tree).toBe(tree);
    expect(commit.parents).toEqual([parent, tree]);
    expect(commit.author.name).toBe("A");
    expect(commit.committer.timezoneOffset).toBe(-300);
    expect(commit.message).toBe("subject\n\nbody\n");
    expect(commit.extraHeaders).toEqual([]);
    expect(messageSubject(commit.message)).toBe("subject");
  });

  it("round-trips a signed commit with its multi-line header", () => {
    const source =
      `tree ${tree}\nauthor A <a@b> 1 +0000\ncommitter C <c@d> 2 +0000\n` +
      "gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n =abcd\n -----END PGP SIGNATURE-----\n" +
      "\nsigned\n";
    roundTrip(source);
    const commit = parseCommit(text(source));
    expect(commitHeader(commit, "gpgsig")).toBe(
      "-----BEGIN PGP SIGNATURE-----\n\niQEzBAABCAAdFiEE\n=abcd\n-----END PGP SIGNATURE-----",
    );
    expect(commit.message).toBe("signed\n");
  });

  it("round-trips unknown headers, mergetag, encoding, and their order", () => {
    roundTrip(
      `tree ${tree}\nparent ${parent}\nauthor A <a@b> 1 +0000\ncommitter C <c@d> 2 +0000\n` +
        "encoding ISO-8859-1\n" +
        `mergetag object ${parent}\n type commit\n tag v1\n tagger T <t@t> 3 +0000\n \n merge message\n` +
        "x-custom one\nx-custom two\ngpgsig-sha256 sig\n" +
        "\nmessage\n",
    );
  });

  it("round-trips messages with and without a trailing newline", () => {
    const head = `tree ${tree}\nauthor A <a@b> 1 +0000\ncommitter C <c@d> 2 +0000\n`;
    for (const message of [
      "",
      "no newline",
      "one\n",
      "two\n\n",
      "\n\nleading blank lines\n",
      "a\r\nb",
    ]) {
      roundTrip(`${head}\n${message}`);
      expect(parseCommit(text(`${head}\n${message}`)).message).toBe(message);
    }
  });

  it("round-trips bytes that are not UTF-8", () => {
    const bytes = latin1(
      `tree ${tree}\nauthor J\xfcrgen <j@b> 1 +0000\ncommitter C <c@d> 2 +0000\nencoding ISO-8859-1\n\ncaf\xe9\n`,
    );
    const commit = parseCommit(bytes);
    expect(commit.latin1).toBe(true);
    expect(commit.author.name).toBe("J\xfcrgen");
    expect(Buffer.compare(serializeCommit(commit), bytes)).toBe(0);
    // And real UTF-8 with the same characters stays UTF-8.
    const utf8 = text(
      `tree ${tree}\nauthor Jürgen <j@b> 1 +0000\ncommitter C <c@d> 2 +0000\n\ncafé ✓\n`,
    );
    const parsed = parseCommit(utf8);
    expect(parsed.latin1).toBeUndefined();
    expect(parsed.author.name).toBe("Jürgen");
    expect(Buffer.compare(serializeCommit(parsed), utf8)).toBe(0);
  });

  it("serialises a commit built in code so git reads it back", () => {
    const repo = makeFixtureRepo({ commits: 2, largeBytes: 1000 });
    const head = git(["rev-parse", "HEAD"], { cwd: repo });
    const headTree = git(["rev-parse", "HEAD^{tree}"], { cwd: repo });
    const bytes = serializeCommit({
      tree: headTree,
      parents: [head],
      author: {
        name: "New Author",
        email: "n@example.com",
        timestamp: 1700009999,
        timezoneOffset: -150,
      },
      committer: {
        name: "New Author",
        email: "n@example.com",
        timestamp: 1700009999,
        timezoneOffset: 330,
      },
      message: "made in code\n",
      extraHeaders: [],
    });
    const oid = git(["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: repo, input: bytes });
    expect(oid).toBe(hashObjectSync("commit", bytes));
    git(["fsck", "--strict"], { cwd: repo });
    expect(git(["log", "-1", "--format=%an|%ad|%cd|%s", "--date=raw", oid], { cwd: repo })).toBe(
      "New Author|1700009999 -0230|1700009999 +0530|made in code",
    );
  });

  it("rejects what is not a commit", () => {
    expect(() => parseCommit(text("author A <a@b> 1 +0000\n\nx"))).toThrow(GitError);
    expect(() => parseCommit(text(`tree ${tree}\ncommitter C <c@d> 2 +0000\n\nx`))).toThrow(
      GitError,
    );
    expect(() => parseCommit(text("tree nothex\nauthor A <a@b> 1 +0000\n"))).toThrow(GitError);
    expect(() => parseCommit(text(" continuation first\n"))).toThrow(GitError);
  });
});

describe("tags", () => {
  const object = "ce013625030ba8dba906f756967f9e9ca394464a";

  it("round-trips a signed tag", () => {
    const source =
      `object ${object}\ntype commit\ntag v1.0\ntagger T <t@t> 3 +0200\n\nrelease\n` +
      "-----BEGIN PGP SIGNATURE-----\n\nabc\n-----END PGP SIGNATURE-----\n";
    const tag = parseTag(text(source));
    expect(tag).toMatchObject({ object, type: "commit", tag: "v1.0" });
    expect(tag.tagger?.timezoneOffset).toBe(120);
    expect(Buffer.compare(serializeTag(tag), text(source))).toBe(0);
  });

  it("round-trips a tag with no tagger and one with extra headers", () => {
    for (const source of [
      `object ${object}\ntype tree\ntag old\n\nancient\n`,
      `object ${object}\ntype tag\ntag nested\ntagger T <t@t> 3 +0000\ngpgsig-sha256 line one\n line two\n\nbody`,
    ]) {
      expect(Buffer.compare(serializeTag(parseTag(text(source))), text(source))).toBe(0);
    }
    expect(parseTag(text(`object ${object}\ntype tree\ntag old\n\nancient\n`)).tagger).toBeNull();
  });

  it("rejects what is not a tag", () => {
    expect(() => parseTag(text(`object ${object}\ntype banana\ntag x\n\n`))).toThrow(GitError);
    expect(() => parseTag(text(`type commit\ntag x\n\n`))).toThrow(GitError);
  });
});

describe("trees", () => {
  const oid = "ce013625030ba8dba906f756967f9e9ca394464a";
  const entry = (mode: TreeEntry["mode"], name: string): TreeEntry => ({ mode, name, oid });

  it("sorts a directory as if its name ended in a slash", () => {
    const sorted = sortTreeEntries([
      entry("100644", "a0"),
      entry("040000", "a"),
      entry("100644", "a.b"),
      entry("100644", "a-b"),
      entry("100644", "a"),
      entry("040000", "a.b.c"),
      entry("100644", "B"),
    ]).map((e) => `${e.mode === "040000" ? "d" : "f"}:${e.name}`);
    expect(sorted).toEqual(["f:B", "f:a", "f:a-b", "f:a.b", "d:a.b.c", "d:a", "f:a0"]);
    expect(compareTreeEntries(entry("040000", "a"), entry("100644", "a.b"))).toBeGreaterThan(0);
    expect(compareTreeEntries(entry("100644", "a"), entry("100644", "a.b"))).toBeLessThan(0);
  });

  it("agrees with git on the order of awkward names", () => {
    const repo = makeFixtureRepo({ commits: 1, largeBytes: 100 });
    const blob = git(["hash-object", "-w", "--stdin"], { cwd: repo, input: "x" });
    const subtree = git(["mktree", "--missing"], {
      cwd: repo,
      input: `100644 blob ${blob}\tinner\n`,
    });
    const names: Array<[TreeEntry["mode"], string]> = [
      ["100644", "foo"],
      ["040000", "foo.d"],
      ["100644", "foo-bar"],
      ["040000", "foo0"],
      ["100644", "foo.txt"],
      ["040000", "fo"],
      ["100644", "Foo"],
      ["100755", "é"],
      ["120000", "link"],
      ["160000", "sub"],
      ["040000", "zz"],
      ["100644", "zz.a"],
      ["100644", "zz0"],
    ];
    const entries = names.map(([mode, name]) => ({
      mode,
      name,
      oid: mode === "040000" ? subtree : mode === "160000" ? oid : blob,
    }));
    const listing = entries
      .map((e) => {
        const type = e.mode === "040000" ? "tree" : e.mode === "160000" ? "commit" : "blob";
        return `${e.mode} ${type} ${e.oid}\t${e.name}\n`;
      })
      .join("");
    const gitOid = git(["mktree", "--missing"], { cwd: repo, input: listing });
    const ours = buildTree(entries);
    expect(hashObjectSync("tree", ours)).toBe(gitOid);
    const fromGit = new Uint8Array(gitRaw(["cat-file", "tree", gitOid], { cwd: repo }).stdout);
    expect(Buffer.compare(ours, fromGit)).toBe(0);
    expect(isSortedTree(parseTree(fromGit))).toBe(true);
  });

  it("round-trips modes git no longer writes", () => {
    const names = ["100664 group", "100600 private", "040000 padded", "100755 exec", "40000 dir"];
    const parts: Uint8Array[] = [];
    for (const name of names) {
      parts.push(text(`${name}\0`), Uint8Array.from(Buffer.from(oid, "hex")));
    }
    const bytes = Buffer.concat(parts);
    const entries = parseTree(bytes);
    expect(entries.map((e) => e.mode)).toEqual(["100644", "100644", "040000", "100755", "040000"]);
    expect(entries.map((e) => e.rawMode)).toEqual([
      "100664",
      "100600",
      "040000",
      undefined,
      undefined,
    ]);
    expect(Buffer.compare(serializeTree(entries), bytes)).toBe(0);
    // Changing the mode drops the stale spelling.
    expect(
      Buffer.from(serializeTree([{ ...entries[0]!, mode: "100755" }])).toString("latin1"),
    ).toMatch(/^100755 group\0/);
    expect(normalizeTreeMode("100644")).toBe("100644");
    expect(normalizeTreeMode("777777")).toBeNull();
    expect(normalizeTreeMode("banana")).toBeNull();
  });

  it("round-trips names that are not UTF-8", () => {
    const bytes = Buffer.concat([
      latin1("100644 caf\xe9.txt\0"),
      Buffer.from(oid, "hex"),
      text("100644 café.txt\0"),
      Buffer.from(oid, "hex"),
    ]);
    const entries = parseTree(bytes);
    expect(entries[0]!.rawName).toBeDefined();
    expect(entries[1]!.rawName).toBeUndefined();
    expect(entries[1]!.name).toBe("café.txt");
    expect(Buffer.compare(serializeTree(entries), bytes)).toBe(0);
  });

  it("refuses to build a tree git would reject", () => {
    for (const name of ["", ".", "..", "a/b", ".git", ".GIT", "nul\0"]) {
      expect(() => buildTree([entry("100644", name)])).toThrow(GitError);
    }
    expect(() => buildTree([entry("100644", "same"), entry("040000", "same")])).toThrow(GitError);
  });

  it("rejects damaged trees", () => {
    expect(() => parseTree(text("100644 name"))).toThrow(GitError);
    expect(() => parseTree(text("100644 name\0short"))).toThrow(GitError);
    expect(() => parseTree(Buffer.concat([text("999999 x\0"), Buffer.alloc(20)]))).toThrow(
      GitError,
    );
    expect(parseTree(new Uint8Array(0))).toEqual([]);
  });
});

describe("a real history", () => {
  let repo = "";
  beforeAll(() => {
    repo = makeFixtureRepo();
  });

  it("round-trips every commit, tree and tag byte for byte", async () => {
    const wanted = listObjects(repo).filter((object) => object.type !== "blob");
    const counts = { commit: 0, tree: 0, tag: 0 };
    for await (const object of catFileBatch(
      repo,
      wanted.map((o) => o.oid),
    )) {
      let again: Uint8Array;
      if (object.type === "commit") again = serializeCommit(parseCommit(object.data));
      else if (object.type === "tree") again = serializeTree(parseTree(object.data));
      else again = serializeTag(parseTag(object.data));
      expect(Buffer.compare(again, object.data), `${object.type} ${object.oid}`).toBe(0);
      expect(hashObjectSync(object.type, again)).toBe(object.oid);
      counts[object.type as "commit" | "tree" | "tag"]++;
    }
    expect(counts.commit).toBeGreaterThan(60);
    expect(counts.tree).toBeGreaterThan(60);
    expect(counts.tag).toBe(1);
  });

  it("reads what git reads from a commit", () => {
    const head = git(["rev-parse", "HEAD"], { cwd: repo });
    const commit = parseCommit(
      new Uint8Array(gitRaw(["cat-file", "commit", head], { cwd: repo }).stdout),
    );
    expect(commit.parents).toEqual(
      git(["log", "-1", "--format=%P", head], { cwd: repo }).split(" "),
    );
    expect(commit.parents).toHaveLength(2);
    expect(commit.tree).toBe(git(["rev-parse", "HEAD^{tree}"], { cwd: repo }));
    expect(commit.author.name).toBe("Ada Author");
    expect(commit.committer.email).toBe("cy@example.com");
    expect(messageSubject(commit.message)).toBe("merge side");
    const tree = parseTree(
      new Uint8Array(gitRaw(["cat-file", "tree", commit.tree], { cwd: repo }).stdout),
    );
    const listed = git(["ls-tree", head], { cwd: repo })
      .split("\n")
      .map((line) => {
        const [meta, name] = line.split("\t");
        const [mode, , oid] = meta!.split(" ");
        return { mode, name, oid };
      });
    expect(tree.map((e) => ({ mode: e.mode, name: e.name, oid: e.oid }))).toEqual(listed);
  });
});
