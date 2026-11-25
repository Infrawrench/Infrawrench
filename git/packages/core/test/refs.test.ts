import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GitError,
  MemoryObjectStore,
  type ObjectReader,
  type StoredRef,
  assertValidRefName,
  branchRef,
  compareRefNames,
  formatSymbolicRef,
  isValidBranchName,
  isValidRefName,
  isValidTagName,
  parseSymbolicRef,
  peelRef,
  peelTags,
  peelToCommit,
  peelToTree,
  refKind,
  resolveRef,
  serializeCommit,
  serializeTag,
  shortRefName,
  tagRef,
} from "../src";
import {
  cleanupTempDirs,
  git,
  gitObjectReader,
  gitRaw,
  hasGit,
  itGit,
  makeFixtureRepo,
  prng,
} from "./helpers";

afterAll(cleanupTempDirs);

function gitAccepts(name: string, flags: string[] = []): boolean {
  return gitRaw(["check-ref-format", ...flags, name], { allowFailure: true }).status === 0;
}

/** Names that sit on every rule's edge, plus random ones made of the characters the rules mention. */
function candidates(): string[] {
  const fixed = [
    "refs/heads/main",
    "refs/heads/feature/x",
    "HEAD",
    "main",
    "@",
    "refs/heads/@",
    "refs/@/x",
    "a/@",
    "refs/heads/a@b",
    "refs/heads/a@{b",
    "refs/heads/@{",
    "refs/heads/a..b",
    "refs/heads/a.b",
    "refs/heads/.a",
    "refs/.heads/a",
    ".refs/heads/a",
    "refs/heads/a.",
    "refs/heads/a./b",
    "refs/heads/a.lock",
    "refs/heads/a.lock/b",
    "refs/heads/a.lockb",
    "refs/heads/.lock",
    "refs/heads/lock",
    "refs/heads/a.LOCK",
    "refs/heads/",
    "/refs/heads/a",
    "refs//heads/a",
    "refs/heads/a/",
    "refs/heads/a b",
    "refs/heads/a~b",
    "refs/heads/a^b",
    "refs/heads/a:b",
    "refs/heads/a?b",
    "refs/heads/a*b",
    "refs/heads/*",
    "refs/*/a",
    "refs/*/*",
    "refs/heads/a**",
    "*",
    "refs/heads/a[b",
    "refs/heads/a]b",
    "refs/heads/a\\b",
    "refs/heads/a\tb",
    "refs/heads/a\x7fb",
    "refs/heads/a\x01b",
    "refs/heads/-a",
    "refs/heads/a-",
    "refs/heads/ünïcödé",
    "refs/heads/日本語",
    "refs/heads/a{b}",
    "refs/heads/a!b#c$d%e&f'g(h)i+j,k;l<m=n>o|p",
    'refs/heads/a"b',
    "refs/heads/a`b",
    "a",
    "a/b",
    "a/b/c/d/e/f",
    ".",
    "..",
    "./a",
    "a/.",
    "a/..",
    "a/.b",
    "a/b.",
    "/",
    "//",
    "a//b",
    "refs/heads/a.b.c",
    "refs/heads/a...b",
    "refs/heads/x.lock.y",
    "refs/heads/@@",
    "refs/heads/{@",
    "x@{0}",
    "x/@{0}",
    " ",
    "a /b",
  ];
  const alphabet = [
    "a",
    "b",
    "/",
    ".",
    "@",
    "{",
    "*",
    "~",
    "^",
    ":",
    "?",
    "[",
    "\\",
    " ",
    "-",
    "l",
    "o",
    "c",
    "k",
  ];
  const next = prng(12);
  const random: string[] = [];
  for (let i = 0; i < 400; i++) {
    let name = "";
    const length = 1 + (next() % 10);
    for (let k = 0; k < length; k++) name += alphabet[next() % alphabet.length]!;
    random.push(next() % 2 === 0 ? `refs/heads/${name}` : name);
  }
  return [...fixed, ...random, "refs/heads/x.lock", "refs/x.lock/y", ".lock", "a/.lock"];
}

describe("ref names", () => {
  itGit("agrees with git check-ref-format on every candidate", () => {
    const disagreements: string[] = [];
    for (const name of candidates()) {
      // The command line would take a leading dash as an option, which says nothing about the name.
      if (name.startsWith("-")) continue;
      if (isValidRefName(name) !== gitAccepts(name))
        disagreements.push(`plain: ${JSON.stringify(name)}`);
      if (
        isValidRefName(name, { allowOneLevel: true }) !== gitAccepts(name, ["--allow-onelevel"])
      ) {
        disagreements.push(`onelevel: ${JSON.stringify(name)}`);
      }
      if (
        isValidRefName(name, { refspecPattern: true }) !== gitAccepts(name, ["--refspec-pattern"])
      ) {
        disagreements.push(`pattern: ${JSON.stringify(name)}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  itGit("agrees with git on branch names", () => {
    const disagreements: string[] = [];
    for (const name of candidates().slice(0, 150)) {
      // `--branch` also expands `@{-1}`-style shorthands, which are not names at all.
      if (name.includes("@{") || name === "@") continue;
      if (isValidBranchName(name) !== gitAccepts(name, ["--branch"]))
        disagreements.push(JSON.stringify(name));
    }
    expect(disagreements).toEqual([]);
    expect(isValidBranchName("-x")).toBe(false);
    expect(isValidBranchName("HEAD")).toBe(false);
    expect(isValidTagName("v1.0")).toBe(true);
    expect(isValidTagName("-v")).toBe(false);
  });

  it("rejects the empty name and names with a NUL", () => {
    expect(isValidRefName("")).toBe(false);
    expect(isValidRefName("refs/heads/a\0b")).toBe(false);
    expect(() => assertValidRefName("refs/heads/a..b")).toThrow(GitError);
    expect(() => assertValidRefName("refs/heads/ok")).not.toThrow();
  });

  it("names and sorts refs", () => {
    expect(branchRef("main")).toBe("refs/heads/main");
    expect(tagRef("v1")).toBe("refs/tags/v1");
    expect(shortRefName("refs/heads/feature/x")).toBe("feature/x");
    expect(shortRefName("refs/tags/v1")).toBe("v1");
    expect(shortRefName("refs/remotes/origin/main")).toBe("origin/main");
    expect(shortRefName("refs/notes/commits")).toBe("notes/commits");
    expect(shortRefName("HEAD")).toBe("HEAD");
    expect(
      ["HEAD", "refs/heads/a", "refs/tags/a", "refs/remotes/o/a", "refs/notes/x", "refs/x"].map(
        refKind,
      ),
    ).toEqual(["head", "branch", "tag", "remote", "note", "other"]);
    const names = [
      "refs/heads/b",
      "refs/heads/B",
      "refs/heads/a/b",
      "refs/heads/a-b",
      "refs/heads/a",
      "HEAD",
    ];
    expect([...names].sort(compareRefNames)).toEqual([
      "HEAD",
      "refs/heads/B",
      "refs/heads/a",
      "refs/heads/a-b",
      "refs/heads/a/b",
      "refs/heads/b",
    ]);
  });
});

describe("symbolic refs", () => {
  it("parses and formats", () => {
    expect(parseSymbolicRef("ref: refs/heads/main\n")).toBe("refs/heads/main");
    expect(parseSymbolicRef("ref:refs/heads/main")).toBe("refs/heads/main");
    expect(parseSymbolicRef("ref: \t refs/heads/main  \n")).toBe("refs/heads/main");
    expect(parseSymbolicRef("ce013625030ba8dba906f756967f9e9ca394464a\n")).toBeNull();
    expect(parseSymbolicRef("ref: refs/heads/a..b\n")).toBeNull();
    expect(formatSymbolicRef("refs/heads/main")).toBe("ref: refs/heads/main\n");
    expect(() => formatSymbolicRef("refs/heads/a b")).toThrow(GitError);
  });

  itGit("reads the HEAD git writes", () => {
    const repo = makeFixtureRepo({ commits: 1, largeBytes: 10 });
    const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd: repo });
    const content = gitRaw(["-C", gitDir, "symbolic-ref", "HEAD"]).stdout.toString();
    expect(content.trim()).toBe("refs/heads/main");
    expect(formatSymbolicRef(content.trim())).toBe("ref: refs/heads/main\n");
  });

  it("follows chains, stops at an unborn branch, and refuses loops", async () => {
    const oid = "ce013625030ba8dba906f756967f9e9ca394464a";
    const refs = new Map<string, StoredRef>([
      ["HEAD", { symref: "refs/heads/main" }],
      ["refs/heads/main", { oid }],
      ["refs/remotes/origin/HEAD", { symref: "HEAD" }],
      ["UNBORN", { symref: "refs/heads/nothing" }],
      ["LOOP", { symref: "LOOP2" }],
      ["LOOP2", { symref: "LOOP" }],
    ]);
    const lookup = (name: string): StoredRef | null => refs.get(name) ?? null;
    expect(await resolveRef(lookup, "HEAD")).toEqual({ name: "refs/heads/main", oid });
    expect(await resolveRef(lookup, "refs/remotes/origin/HEAD")).toEqual({
      name: "refs/heads/main",
      oid,
    });
    expect(await resolveRef(lookup, "refs/heads/main")).toEqual({ name: "refs/heads/main", oid });
    expect(await resolveRef(lookup, "UNBORN")).toBeNull();
    expect(await resolveRef(lookup, "missing")).toBeNull();
    await expect(resolveRef(lookup, "LOOP")).rejects.toThrow(GitError);
  });
});

describe("peeling", () => {
  let repo = "";
  let reader: ObjectReader;
  beforeAll(() => {
    if (!hasGit) return;
    repo = makeFixtureRepo({ commits: 30, largeBytes: 1000 });
    reader = gitObjectReader(repo);
  });

  itGit("peels what git peels", async () => {
    const rev = (name: string): string => git(["rev-parse", name], { cwd: repo });
    const tag = rev("refs/tags/v1.0");
    expect(await peelTags(reader, tag)).toEqual({ oid: rev("v1.0^{}"), type: "commit" });
    expect(await peelToCommit(reader, tag)).toBe(rev("v1.0^{commit}"));
    expect(await peelToTree(reader, tag)).toBe(rev("v1.0^{tree}"));
    const head = rev("HEAD");
    expect(await peelTags(reader, head)).toEqual({ oid: head, type: "commit" });
    expect(await peelToTree(reader, head)).toBe(rev("HEAD^{tree}"));
    const tree = rev("HEAD^{tree}");
    expect(await peelToCommit(reader, tree)).toBeNull();
    expect(await peelToTree(reader, tree)).toBe(tree);
    const blob = rev("HEAD:bin/run.sh");
    expect(await peelToTree(reader, blob)).toBeNull();

    expect(await peelRef(reader, { name: "refs/tags/v1.0", oid: tag })).toEqual({
      name: "refs/tags/v1.0",
      oid: tag,
      peeled: rev("v1.0^{}"),
    });
    const light = { name: "refs/tags/light", oid: rev("refs/tags/light") };
    expect(await peelRef(reader, light)).toEqual(light);
  });

  it("follows a tag of a tag and refuses a missing object or an endless chain", async () => {
    const store = new MemoryObjectStore();
    const tree = store.write("tree", new Uint8Array(0));
    const person = { name: "A", email: "a@b", timestamp: 1, timezoneOffset: 0 };
    const commit = store.write(
      "commit",
      serializeCommit({
        tree,
        parents: [],
        author: person,
        committer: person,
        message: "c\n",
        extraHeaders: [],
      }),
    );
    let target = commit;
    let type: "commit" | "tag" = "commit";
    const tags: string[] = [];
    for (let depth = 0; depth < 40; depth++) {
      target = store.write(
        "tag",
        serializeTag({
          object: target,
          type,
          tag: `t${depth}`,
          tagger: person,
          message: "m\n",
          extraHeaders: [],
        }),
      );
      type = "tag";
      tags.push(target);
    }
    expect(await peelTags(store, tags[2]!)).toEqual({ oid: commit, type: "commit" });
    expect(await peelToTree(store, tags[2]!)).toBe(tree);
    await expect(peelTags(store, tags[39]!)).rejects.toThrow(/nested too deeply/);
    await expect(peelTags(store, "0123456789012345678901234567890123456789")).rejects.toThrow(
      /missing/,
    );
  });
});
