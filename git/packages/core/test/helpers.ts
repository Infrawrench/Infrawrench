/** Drives the real `git` binary in throwaway directories. Nothing here reaches the network. */
import { type SpawnSyncOptions, spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import type { ObjectId, ObjectType } from "../src";

const roots: string[] = [];

/**
 * Whether there is a `git` to test against. Where there is none (a sandbox
 * without the binary) the interop suites skip and say so, and the suites
 * that need nothing but this package still run.
 */
export const hasGit = spawnSync("git", ["--version"]).status === 0;
if (!hasGit) console.warn("git-core: no git binary on PATH, interop tests are skipped");

export const describeGit = describe.skipIf(!hasGit) as typeof describe;
export const itGit = it.skipIf(!hasGit) as typeof it;

export function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `git-core-${label}-`));
  roots.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
}

// A fixed identity and no user or system configuration, so every run makes the same objects.
const ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: "/nonexistent",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Ada Author",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Cy Committer",
  GIT_COMMITTER_EMAIL: "cy@example.com",
  TZ: "UTC",
};

export interface GitOptions {
  readonly cwd?: string;
  readonly input?: Uint8Array | string;
  readonly env?: Record<string, string>;
  /** Return instead of throwing when git exits non-zero. */
  readonly allowFailure?: boolean;
}

export interface GitResult {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

export function gitRaw(args: readonly string[], options: GitOptions = {}): GitResult {
  const spawnOptions: SpawnSyncOptions = {
    env: { ...ENV, ...options.env },
    maxBuffer: 2 ** 31 - 1,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
  };
  const result = spawnSync("git", args, spawnOptions);
  if (result.error) throw result.error;
  const status = result.status ?? -1;
  const stderr = (result.stderr as Buffer).toString("utf8");
  if (status !== 0 && !options.allowFailure) {
    throw new Error(`git ${args.join(" ")} exited ${status}: ${stderr}`);
  }
  return { status, stdout: result.stdout as Buffer, stderr };
}

/** Runs git and returns its stdout as trimmed text. */
export function git(args: readonly string[], options: GitOptions = {}): string {
  return gitRaw(args, options).stdout.toString("utf8").trim();
}

/** Streams git's stdout in chunks, for output too large to buffer. */
export function gitStream(
  args: readonly string[],
  options: GitOptions = {},
): AsyncIterable<Buffer> {
  const child = spawn("git", args, {
    env: { ...ENV, ...options.env },
    stdio: ["pipe", "pipe", "inherit"],
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  });
  child.stdin.end(options.input ?? "");
  return child.stdout;
}

export interface ListedObject {
  readonly oid: ObjectId;
  readonly type: ObjectType;
  readonly size: number;
}

/** Every object in the repository, as git itself reports them. */
export function listObjects(repo: string): ListedObject[] {
  const out = git(["cat-file", "--batch-all-objects", "--batch-check", "--unordered"], {
    cwd: repo,
  });
  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [oid, type, size] = line.split(" ");
      return { oid: oid!, type: type as ObjectType, size: Number(size) };
    });
}

export function catFile(repo: string, oid: ObjectId): { type: ObjectType; data: Uint8Array } {
  const type = git(["cat-file", "-t", oid], { cwd: repo }) as ObjectType;
  const data = gitRaw(["cat-file", type, oid], { cwd: repo }).stdout;
  return { type, data: new Uint8Array(data) };
}

/**
 * The content of many objects through one `git cat-file --batch`, parsed as
 * it streams so a whole history's worth never sits in memory at once.
 */
export async function* catFileBatch(
  repo: string,
  oids: readonly ObjectId[],
): AsyncGenerator<{ oid: ObjectId; type: ObjectType; data: Uint8Array }, void, void> {
  const stream = gitStream(["cat-file", "--batch"], { cwd: repo, input: `${oids.join("\n")}\n` });
  let buffer: Buffer = Buffer.alloc(0);
  let header: { oid: string; type: ObjectType; size: number } | null = null;
  for await (const chunk of stream) {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    for (;;) {
      if (!header) {
        const newline = buffer.indexOf(10);
        if (newline < 0) break;
        const [oid, type, size] = buffer.subarray(0, newline).toString("latin1").split(" ");
        if (type === "missing") throw new Error(`git does not have ${oid}`);
        header = { oid: oid!, type: type as ObjectType, size: Number(size) };
        buffer = buffer.subarray(newline + 1);
      }
      // The content is followed by one newline that is not part of it.
      if (buffer.length < header.size + 1) break;
      yield {
        oid: header.oid,
        type: header.type,
        data: new Uint8Array(buffer.subarray(0, header.size)),
      };
      buffer = buffer.subarray(header.size + 1);
      header = null;
    }
  }
  if (header || buffer.length > 0) throw new Error("git cat-file --batch output ended early");
}

/** The `.pack` files of a repository (bare or not), with their `.idx` beside them. */
export function packFiles(repo: string): Array<{ pack: string; idx: string }> {
  const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd: repo });
  const dir = join(gitDir, "objects", "pack");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".pack"))
    .sort()
    .map((name) => ({ pack: join(dir, name), idx: join(dir, name.replace(/\.pack$/, ".idx")) }));
}

export function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

/**
 * A range reader over a file, standing in for R2: each call is a real
 * positioned read, so nothing depends on the pack being in memory.
 */
export async function fileRangeReader(path: string): Promise<{
  read: (offset: number, length: number) => Promise<Uint8Array>;
  close: () => Promise<void>;
  calls: () => number;
}> {
  const handle = await open(path, "r");
  let calls = 0;
  return {
    read: async (offset, length) => {
      calls++;
      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    },
    close: () => handle.close(),
    calls: () => calls,
  };
}

/** Cuts a buffer into chunks of varying size, the way a network delivers a body. */
export function* chunked(
  bytes: Uint8Array,
  size: number | (() => number),
): Generator<Uint8Array, void, void> {
  for (let at = 0; at < bytes.length;) {
    const take = Math.max(1, typeof size === "number" ? size : size());
    yield bytes.subarray(at, Math.min(bytes.length, at + take));
    at += take;
  }
}

/** An `ObjectReader` that asks a real repository, for the bases a thin pack leaves out. */
export function gitObjectReader(repo: string): {
  read(oid: ObjectId): Promise<{ type: ObjectType; data: Uint8Array } | null>;
  has(oid: ObjectId): Promise<boolean>;
  reads: ObjectId[];
} {
  const reads: ObjectId[] = [];
  const exists = (oid: ObjectId): boolean =>
    gitRaw(["cat-file", "-e", oid], { cwd: repo, allowFailure: true }).status === 0;
  return {
    reads,
    async read(oid) {
      reads.push(oid);
      return exists(oid) ? catFile(repo, oid) : null;
    },
    async has(oid) {
      return exists(oid);
    },
  };
}

/** A small deterministic generator: the fixtures are the same on every run and every machine. */
export function prng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

export function randomBytes(length: number, next: () => number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = next() & 0xff;
  return out;
}

const WORDS = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliet",
  "kilo",
  "lima",
  "mike",
  "november",
  "oscar",
  "papa",
  "quebec",
  "romeo",
];

function sourceLine(next: () => number): string {
  const words: string[] = [];
  const count = 3 + (next() % 9);
  for (let i = 0; i < count; i++) words.push(WORDS[next() % WORDS.length]!);
  return `${"  ".repeat(next() % 4)}${words.join(" ")};`;
}

export interface FixtureOptions {
  readonly commits?: number;
  readonly seed?: number;
  /** Size of the large binary file that is rewritten in part a few times. Default 3 MiB. */
  readonly largeBytes?: number;
}

/**
 * A repository with what makes packs interesting: text files edited a few
 * lines at a time (long delta chains), binary files, a file of a few
 * megabytes, renames, deletions, a merge, an annotated tag, a symlink and an
 * executable.
 */
export function makeFixtureRepo(options: FixtureOptions = {}): string {
  const commits = options.commits ?? 60;
  const next = prng(options.seed ?? 42);
  const repo = tempDir("fixture");
  const run = (args: string[], extra: GitOptions = {}): string =>
    git(args, { cwd: repo, ...extra });
  run(["init", "-q", "-b", "main"]);
  run(["config", "core.autocrlf", "false"]);

  const files = new Map<string, string[]>();
  for (let i = 0; i < 12; i++) {
    const lines: string[] = [];
    for (let k = 0; k < 150 + (next() % 200); k++) lines.push(sourceLine(next));
    files.set(`src/module-${i}.txt`, lines);
  }
  const write = (path: string, data: string | Uint8Array): void => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), data);
  };
  for (const [path, lines] of files) write(path, `${lines.join("\n")}\n`);
  write("assets/logo.bin", randomBytes(40_000, next));
  let large = randomBytes(options.largeBytes ?? 3 * 1024 * 1024, next);
  write("assets/large.bin", large);
  write("bin/run.sh", "#!/bin/sh\necho run\n");
  run(["update-index", "--add", "--chmod=+x", "bin/run.sh"]);
  run(["add", "-A"]);
  let clock = 1_700_000_000;
  const commit = (message: string): void => {
    clock += 3600;
    const date = `${clock} +0000`;
    run(["commit", "-q", "-m", message], {
      env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  };
  commit("initial import");

  for (let c = 1; c < commits; c++) {
    const paths = [...files.keys()];
    for (let edits = 0; edits < 3; edits++) {
      const path = paths[next() % paths.length]!;
      const lines = files.get(path)!;
      const at = next() % lines.length;
      const kind = next() % 3;
      if (kind === 0) lines.splice(at, 0, sourceLine(next), sourceLine(next));
      else if (kind === 1 && lines.length > 20) lines.splice(at, 1 + (next() % 3));
      else lines[at] = sourceLine(next);
      write(path, `${lines.join("\n")}\n`);
    }
    if (c % 9 === 0) {
      // A rename with a small edit, which leaves a blob that deltas well against the old path's.
      const from = paths[next() % paths.length]!;
      const to = from.replace(/[a-z0-9-]+\.txt$/, `renamed-${c}.txt`);
      const lines = files.get(from)!;
      files.delete(from);
      files.set(to, lines);
      run(["mv", from, to]);
    }
    if (c % 14 === 0) {
      // Rewrite a slice of the large file: the new version is a delta against the old one.
      large = large.slice();
      const slice = Math.min(4096, large.length >> 1);
      large.set(randomBytes(slice, next), next() % (large.length - slice));
      write("assets/large.bin", large);
    }
    if (c % 17 === 0) write(`assets/blob-${c}.bin`, randomBytes(2000 + (next() % 30_000), next));
    if (c === 20) {
      write("docs/guide.md", "# Guide\n\nRead the source.\n");
      symlinkSync("guide.md", join(repo, "docs/link"));
    }
    if (c === 25) {
      const date = `${clock} +0000`;
      run(["tag", "-a", "v1.0", "-m", "first release\n\nwith a body"], {
        env: { GIT_COMMITTER_DATE: date },
      });
    }
    run(["add", "-A"]);
    commit(`change ${c}: ${sourceLine(next).trim()}`);
  }

  if (commits < 8) return repo;
  // A side branch and a merge, so some commit has two parents.
  run(["checkout", "-q", "-b", "side", "HEAD~5"]);
  write("side.txt", "on a side branch\n");
  run(["add", "-A"]);
  commit("side work");
  run(["checkout", "-q", "main"]);
  clock += 3600;
  run(["merge", "-q", "--no-ff", "-m", "merge side", "side"], {
    env: { GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` },
  });
  run(["tag", "light"]);
  return repo;
}
