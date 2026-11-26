/**
 * Bytes a push controls: packs, deltas, zlib, pkt-lines, objects and ref
 * names built to cost the server or to hurt whoever clones them. Each is
 * refused with a `GitError` before it costs much, and nothing throws
 * anything else.
 */
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  GitError,
  ObjectFsck,
  type ObjectId,
  type TreeEntry,
  applyDelta,
  buildPack,
  createDelta,
  decodeLooseObject,
  decodePktLines,
  fsckCommit,
  fsckGitattributes,
  fsckGitmodules,
  fsckTag,
  fsckTree,
  hashObjectSync,
  indexPack,
  inflate,
  isValidRefName,
  memoryRangeReader,
  parseCommit,
  parseTag,
  parseTree,
  serializeTree,
} from "../src";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const OID = "a".repeat(40);
const OTHER = "b".repeat(40);

/** A delta's size header: two base-128 numbers, low bits first. */
function sizes(base: number, result: number): number[] {
  const out: number[] = [];
  for (let value of [base, result]) {
    do {
      let byte = value % 128;
      value = Math.floor(value / 128);
      if (value > 0) byte |= 0x80;
      out.push(byte);
    } while (value > 0);
  }
  return out;
}

const code = (error: unknown): string | null => (error instanceof GitError ? error.code : null);

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("applyDelta", () => {
  const base = text("0123456789");
  const refused: ReadonlyArray<readonly [string, number[]]> = [
    ["a base of the wrong size", [...sizes(9, 1), 0x01, 0x41]],
    ["a copy past the end of the base", [...sizes(10, 5), 0x91, 8, 5]],
    ["a copy with an offset past the end", [...sizes(10, 1), 0x91, 200, 1]],
    ["a copy past the declared size", [...sizes(10, 2), 0x90, 5]],
    ["an insert past the declared size", [...sizes(10, 1), 0x02, 0x41, 0x42]],
    ["fewer bytes than declared", [...sizes(10, 5), 0x90, 3]],
    ["the reserved instruction", [...sizes(10, 1), 0x00]],
    ["a copy cut short", [...sizes(10, 1), 0x91]],
    ["an insert cut short", [...sizes(10, 3), 0x03, 0x41]],
    ["a size header cut short", [0x8a]],
    ["a size over 2^53", [...Array<number>(9).fill(0xff), 0x7f, 1]],
  ];
  it.each(refused)("refuses %s", (_, bytes) => {
    let thrown: unknown = null;
    try {
      applyDelta(base, Uint8Array.from(bytes));
    } catch (error) {
      thrown = error;
    }
    expect(code(thrown)).toBe("bad-delta");
  });

  it("applies one that adds up", () => {
    const delta = Uint8Array.from([...sizes(10, 4), 0x91, 2, 3, 0x01, 0x21]);
    expect(new TextDecoder().decode(applyDelta(base, delta))).toBe("234!");
  });
});

describe("indexing a hostile pack", () => {
  it("refuses a delta whose own instructions are over the object limit, before inflating them", async () => {
    // The result it declares is tiny; the instructions are not. Read back
    // whole in `finish`, they would be held in memory however large.
    const blob = text("x".repeat(100));
    const instructions = new Uint8Array(2 * 1024 * 1024);
    instructions.set(sizes(100, 1));
    const built = await buildPack([
      { type: "blob", data: blob, oid: hashObjectSync("blob", blob) },
      {
        type: "ofs-delta",
        base: hashObjectSync("blob", blob),
        compressed: new Uint8Array(zlib.deflateSync(instructions)),
        size: instructions.length,
      },
    ]);
    const error = await failure(
      indexPack([built.pack], {
        maxObjectBytes: 1024 * 1024,
        cacheBytes: 1024 * 1024,
        readRange: memoryRangeReader(built.pack),
      }),
    );
    expect(code(error)).toBe("limit");
  });

  it("bounds the bytes a pack may inflate to, deltas and rebuilt objects included", async () => {
    const base = new Uint8Array(256 * 1024).fill(7);
    const baseOid = hashObjectSync("blob", base);
    // Each delta copies the whole base: a few bytes each, a quarter of a megabyte out.
    const copy = createDelta(base, base);
    expect(copy.length).toBeLessThan(64);
    const inputs = [
      { type: "blob" as const, data: base, oid: baseOid },
      ...Array.from({ length: 40 }, () => ({
        type: "ofs-delta" as const,
        base: baseOid,
        data: copy,
      })),
    ];
    const built = await buildPack(inputs);
    const options = { readRange: memoryRangeReader(built.pack) };
    const whole = await indexPack([built.pack], options);
    expect(whole.objectCount).toBe(41);
    const error = await failure(
      indexPack([built.pack], { ...options, maxInflatedBytes: 4 * 1024 * 1024 }),
    );
    expect(code(error)).toBe("limit");
    expect((error as Error).message).toMatch(/inflates past/);
  });

  it("follows a long delta chain without recursion", async () => {
    let previous = text("start");
    let previousOid = hashObjectSync("blob", previous);
    const inputs: Parameters<typeof buildPack>[0][number][] = [
      { type: "blob", data: previous, oid: previousOid },
    ];
    for (let i = 0; i < 20_000; i++) {
      const next = text(`start ${i}`);
      const oid = hashObjectSync("blob", next);
      inputs.push({ type: "ofs-delta", base: previousOid, data: createDelta(previous, next), oid });
      previous = next;
      previousOid = oid;
    }
    const built = await buildPack(inputs);
    const result = await indexPack([built.pack], { readRange: memoryRangeReader(built.pack) });
    expect(result.objects.oid(result.objectCount - 1)).toBe(previousOid);
  }, 60_000);

  it("refuses an entry that claims 2^60 bytes, and an ofs-delta to itself or before the pack", async () => {
    const header = Uint8Array.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 1]);
    // A blob whose size varint runs to 2^60.
    const huge = Uint8Array.from([0xbf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]);
    for (const entry of [
      huge,
      // ofs-delta, size 1, distance 0: itself.
      Uint8Array.from([0x61, 0x00]),
      // ofs-delta, size 1, distance 20: before the pack header.
      Uint8Array.from([0x61, 0x14]),
    ]) {
      const pack = new Uint8Array(header.length + entry.length + 64);
      pack.set(header);
      pack.set(entry, header.length);
      const error = await failure(indexPack([pack]));
      expect(code(error), Array.from(entry).join(",")).toBe("bad-pack");
    }
  });
});

describe("inflating a loose object", () => {
  it("stops at the size limit while the stream is still producing", async () => {
    const bomb = new Uint8Array(zlib.deflateSync(Buffer.alloc(8 * 1024 * 1024)));
    expect(code(await failure(inflate(bomb, { maxSize: 1024 * 1024 })))).toBe("limit");
    const loose = new Uint8Array(
      zlib.deflateSync(
        Buffer.concat([Buffer.from("blob 2097152\0"), Buffer.alloc(2 * 1024 * 1024)]),
      ),
    );
    expect(code(await failure(decodeLooseObject(loose, 1024 * 1024)))).toBe("limit");
    expect((await decodeLooseObject(loose)).data.length).toBe(2 * 1024 * 1024);
  });
});

describe("pkt-line lengths", () => {
  it.each(["0003", "000g", "zzzz", "fff1", "ffff", "-001", " 004"])("refuses %s", (length) => {
    let thrown: unknown = null;
    try {
      decodePktLines(text(`${length}${"x".repeat(8)}`));
    } catch (error) {
      thrown = error;
    }
    expect(code(thrown)).toBe("bad-pkt-line");
  });

  it("reads the markers and an empty packet", () => {
    expect(decodePktLines(text("0000000100020004")).map((pkt) => pkt.type)).toEqual([
      "flush",
      "delim",
      "response-end",
      "data",
    ]);
  });
});

describe("ref names", () => {
  it.each([
    "refs/heads/a\u0001b",
    "refs/heads/a\u007fb",
    "refs/heads/a@{1}",
    "refs/heads/a..b",
    "refs/heads/a.lock",
    "refs/heads/a.lock/b",
    "refs/heads/a.",
    "refs/heads/a/",
    "refs/heads/a\\b",
    "refs/heads//a",
    "refs/heads/.a",
    "refs/heads/a b",
    "refs/heads/a:b",
    "refs/heads/a?b",
    "refs/heads/a[b",
    "refs/heads/a^b",
    "refs/heads/a~b",
    "refs/heads/a*b",
    "@",
    "",
  ])("refuses %j", (name) => {
    expect(isValidRefName(name)).toBe(false);
  });
});

describe("parsing hostile objects", () => {
  it("throws nothing but GitError on random bytes", () => {
    let seed = 12345;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const alphabet = text("tree parent author committer object type tag 0123456789abcdef <>\n\0 ");
    for (let round = 0; round < 3000; round++) {
      const length = Math.floor(random() * 200);
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        bytes[i] =
          random() < 0.7
            ? alphabet[Math.floor(random() * alphabet.length)]!
            : Math.floor(random() * 256);
      }
      for (const parse of [parseCommit, parseTag, parseTree, fsckCommit, fsckTag, fsckTree]) {
        try {
          parse(bytes);
        } catch (error) {
          expect(error).toBeInstanceOf(GitError);
        }
      }
    }
  });

  it("parses a commit with 100 000 parents and a 30 MiB header line in linear time", () => {
    const parents = Array.from({ length: 100_000 }, () => `parent ${OID}\n`).join("");
    const many = text(`tree ${OID}\n${parents}author a <a> 1 +0000\ncommitter a <a> 1 +0000\n\nm`);
    const started = Date.now();
    expect(parseCommit(many).parents).toHaveLength(100_000);
    const long = text(
      `tree ${OID}\nauthor ${"a".repeat(30 * 1024 * 1024)} <a> 1 +0000\ncommitter a <a> 1 +0000\n\n`,
    );
    expect(parseCommit(long).author.email).toBe("a");
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});

describe("fsck: trees", () => {
  const entry = (name: string | Uint8Array, mode: TreeEntry["mode"] = "100644"): TreeEntry =>
    typeof name === "string"
      ? { mode, name, oid: OID }
      : { mode, name: new TextDecoder().decode(name), rawName: name, oid: OID };
  const tree = (...entries: TreeEntry[]): Uint8Array => serializeTree(entries);

  const refused: ReadonlyArray<readonly [string, Uint8Array]> = [
    [".", tree(entry("."))],
    // ci-reads-ignore: tree entry names under test, not a path read from disk
    ["..", tree(entry("..", "040000"))],
    [".git", tree(entry(".git", "040000"))],
    [".GIT", tree(entry(".GIT", "040000"))],
    [".Git as a file", tree(entry(".Git"))],
    ["git~1", tree(entry("git~1", "040000"))],
    ["GIT~1", tree(entry("GIT~1", "040000"))],
    [".git. (NTFS)", tree(entry(".git.", "040000"))],
    [".git with trailing spaces (NTFS)", tree(entry(".git  ", "040000"))],
    [".git::$INDEX_ALLOCATION (NTFS)", tree(entry(".git::$INDEX_ALLOCATION", "040000"))],
    [".git\\x (NTFS)", tree(entry(".git\\x"))],
    [".g‌it (HFS+)", tree(entry(".g‌it", "040000"))],
    ["‍.git (HFS+)", tree(entry("‍.git", "040000"))],
    [".git﻿ (HFS+)", tree(entry(".git﻿", "040000"))],
    [".gi⁪t (HFS+)", tree(entry(".gi⁪t", "040000"))],
    [
      ".git then bytes that are not UTF-8 (HFS+)",
      tree(entry(Uint8Array.from([0x2e, 0x67, 0x69, 0x74, 0xff]))),
    ],
    ["a slash", tree(entry("a/b"))],
    ["two entries with one name", tree(entry("a"), entry("a"))],
    ["a file and a directory with one name", tree(entry("a"), entry("a.b"), entry("a", "040000"))],
    ["entries out of order", tree(entry("b"), entry("a"))],
    [".gitmodules as a symbolic link", tree(entry(".gitmodules", "120000"))],
    ["GITMOD~1 as a symbolic link", tree(entry("GITMOD~1", "120000"))],
    [".gitmodules. as a symbolic link (NTFS)", tree(entry(".gitmodules.", "120000"))],
    ["gi7eba~1 as a symbolic link", tree(entry("gi7eba~1", "120000"))],
    [".gitmodules as a directory", tree(entry(".gitmodules", "040000"))],
    [".gitattributes as a directory", tree(entry(".gitattributes", "040000"))],
    ["an empty name", Uint8Array.from([...text("100644 "), 0, ...new Uint8Array(20)])],
  ];
  it.each(refused)("refuses %s", (_, data) => {
    let thrown: unknown = null;
    try {
      fsckTree(data);
    } catch (error) {
      thrown = error;
    }
    expect(code(thrown)).toBe("bad-object");
  });

  it("takes names that only look alike, and finds the special files", () => {
    const data = tree(
      entry(".git-blame-ignore-revs"),
      entry(".gitattributes"),
      entry(".github", "040000"),
      entry(".gitignore"),
      entry(".gitmodules"),
      entry(".gitx"),
      entry("git"),
      entry("git~2", "040000"),
      entry("été"),
    );
    expect(fsckTree(data)).toEqual({ gitmodules: [OID], gitattributes: [OID] });
    // A symbolic link named .gitattributes is allowed and not read.
    expect(fsckTree(tree(entry(".gitattributes", "120000")))).toEqual({
      gitmodules: [],
      gitattributes: [],
    });
  });
});

describe("fsck: .gitmodules", () => {
  const refused: ReadonlyArray<readonly [string, string]> = [
    [
      "a name that climbs",
      '[submodule "../../hooks"]\n\tpath = a\n\turl = https://example.com/a\n',
    ],
    ["a name that climbs in the middle", '[submodule "a/../../b"]\n\turl = ./a\n'],
    ["a name that climbs with backslashes", '[submodule "a\\\\..\\\\..\\\\b"]\n\turl = ./a\n'],
    ["an empty name", '[submodule ""]\n\turl = ./a\n'],
    [
      "an old-style section that climbs",
      "[submodule.a]\n\turl = ./a\n[submodule...]\n\turl = ./b\n",
    ],
    ["a url that is an option", '[submodule "a"]\n\turl = -oProxyCommand=touch\n'],
    ["a quoted url that is an option", '[submodule "a"]\n\turl = "-u./payload"\n'],
    ["a path that is an option", '[submodule "a"]\n\tpath = -x\n'],
    ["an update command", '[submodule "a"]\n\tupdate = !rm -rf ~\n'],
    ["an update command in another case", '[submodule "a"]\n\tUPDATE = !touch x\n'],
    [
      "a url with an encoded newline",
      '[submodule "a"]\n\turl = https://example.com/a%0ahost=other\n',
    ],
    ["a helper url with an encoded newline", '[submodule "a"]\n\turl = https::example.com/%0a\n'],
    ["a relative url with an encoded newline", '[submodule "a"]\n\turl = ./a%0Ab\n'],
    ["a git url with an encoded newline", '[submodule "a"]\n\turl = git://example.com/%0a\n'],
    ["a relative url that climbs past its host", '[submodule "a"]\n\turl = ../../:example.com/a\n'],
    ["a relative url that climbs to a slash", '[submodule "a"]\n\turl = ./../..//example.com/a\n'],
    ["a key continued across lines", '[submodule "a"]\n\turl = \\\n-oProxyCommand=x\n'],
    ["a base and subsection joined", '[submodule.x "/../y"]\n\turl = ./a\n'],
  ];
  it.each(refused)("refuses %s", (_, content) => {
    let thrown: unknown = null;
    try {
      fsckGitmodules(text(content));
    } catch (error) {
      thrown = error;
    }
    expect(code(thrown)).toBe("bad-object");
  });

  it("takes ordinary files, and stops where git would stop parsing", () => {
    for (const content of [
      '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = https://example.com/lib.git\n\tbranch = main\n',
      '[submodule "a"]\n\turl = ../sibling.git ; a comment\n\tupdate = rebase\n',
      '[submodule "a"]\n\turl = git@example.com:org/a.git\n\tpath = "with space"\n',
      '[submodule "a..b"]\n\turl = ./a\n',
      "# only a comment\n",
      // An unterminated quote ends the parse; git reads nothing after it either.
      '[submodule "a"]\n\turl = "./a\n[submodule "../x"]\n\turl = -x\n',
      "﻿[core]\n\tbare = false\n",
    ]) {
      expect(() => fsckGitmodules(text(content)), content).not.toThrow();
    }
  });
});

describe("fsck: .gitattributes, commits and tags", () => {
  it("refuses an attributes line git cannot hold", () => {
    expect(() => fsckGitattributes(text(`${"a".repeat(2047)}\n*.c text\n`))).not.toThrow();
    expect(() => fsckGitattributes(text(`*.c text\n${"a".repeat(2048)}\n`))).toThrow(GitError);
    // git stops at a NUL, so what follows one is not a line to it.
    expect(() => fsckGitattributes(text(`a\0${"a".repeat(4000)}`))).not.toThrow();
  });

  it("refuses a NUL among a commit's or a tag's headers, and missing headers", () => {
    const commit = `tree ${OID}\nauthor a <a> 1 +0000\ncommitter a <a> 1 +0000\n`;
    expect(() => fsckCommit(text(`${commit}\nmessage\0 is fine`))).not.toThrow();
    expect(() =>
      fsckCommit(text(`tree ${OID}\nauthor a\0 <a> 1 +0000\ncommitter a <a> 1 +0000\n\nm`)),
    ).toThrow(GitError);
    expect(() => fsckCommit(text(`author a <a> 1 +0000\ntree ${OID}\n\nm`))).toThrow(GitError);
    const tag = `object ${OID}\ntype commit\ntag v1\ntagger a <a> 1 +0000\n`;
    expect(() => fsckTag(text(`${tag}\nm`))).not.toThrow();
    expect(() => fsckTag(text(`object ${OID}\ntype commit\ntag v\x001\n\nm`))).toThrow(GitError);
    expect(() => fsckTag(text(`type commit\ntag v1\n\nm`))).toThrow(GitError);
  });
});

describe("fsck over a pack", () => {
  const gitmodulesTree = (blob: ObjectId): Uint8Array =>
    serializeTree([{ mode: "100644", name: ".gitmodules", oid: blob }]);

  it("checks a .gitmodules blob whichever comes first, and reads the rest at the end", async () => {
    const bad = text('[submodule "../x"]\n\turl = ./a\n');
    const badOid = hashObjectSync("blob", bad);
    const first = new ObjectFsck();
    first.note(badOid, "blob", bad);
    first.note(OTHER, "tree", gitmodulesTree(badOid));
    expect(first.pending()).toEqual([badOid]);
    await expect(first.finish(async () => bad)).rejects.toBeInstanceOf(GitError);

    const after = new ObjectFsck();
    after.note(OTHER, "tree", gitmodulesTree(badOid));
    expect(() => after.note(badOid, "blob", bad)).toThrow(GitError);

    const missing = new ObjectFsck();
    missing.note(OTHER, "tree", gitmodulesTree(badOid));
    await expect(missing.finish(async () => null)).rejects.toBeInstanceOf(GitError);

    const good = text('[submodule "a"]\n\turl = ./a\n');
    const goodOid = hashObjectSync("blob", good);
    const fine = new ObjectFsck();
    fine.note(OTHER, "tree", gitmodulesTree(goodOid));
    fine.note(goodOid, "blob", good);
    expect(fine.pending()).toEqual([]);
    await fine.finish(async () => {
      throw new Error("nothing left to read");
    });
  });

  it("checks a blob again when a second tree names it as the other kind", async () => {
    const content = text(`${"a".repeat(3000)}\n`);
    const oid = hashObjectSync("blob", content);
    const check = new ObjectFsck();
    check.note(OTHER, "tree", gitmodulesTree(oid));
    check.note(oid, "blob", content);
    check.note(OID, "tree", serializeTree([{ mode: "100644", name: ".gitattributes", oid }]));
    expect(check.pending()).toEqual([oid]);
    await expect(check.finish(async () => content)).rejects.toBeInstanceOf(GitError);
  });
});
