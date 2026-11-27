/** Drives the real `git` binary in throwaway directories. Nothing here reaches the network. */
import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe } from "vitest";
import { MemoryObjectStore, type ObjectId, type ObjectType } from "@infrawrench/git-core";

const roots: string[] = [];

/** Where there is no `git` (a sandbox without the binary) every suite here skips and says so. */
export const hasGit = spawnSync("git", ["--version"]).status === 0;
if (!hasGit) console.warn("git-ops: no git binary on PATH, the interop tests are skipped");
export const describeGit = describe.skipIf(!hasGit) as typeof describe;

export function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `git-ops-${label}-`));
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

/** Runs git and returns its stdout as text without the final newline. */
export function git(args: readonly string[], options: GitOptions = {}): string {
  return gitRaw(args, options).stdout.toString("utf8").replace(/\n$/, "");
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

/** A working repository with a clock that only moves when told to. */
export class Repo {
  readonly dir: string;
  clock = 1_700_000_000;

  constructor(label = "repo") {
    this.dir = tempDir(label);
    this.run("init", "-q", "-b", "main");
    this.run("config", "core.autocrlf", "false");
  }

  run(...args: string[]): string {
    return git(args, { cwd: this.dir, env: this.dates() });
  }

  raw(args: readonly string[], options: GitOptions = {}): GitResult {
    return gitRaw(args, { cwd: this.dir, ...options, env: { ...this.dates(), ...options.env } });
  }

  private dates(): Record<string, string> {
    const date = `${this.clock} +0000`;
    return { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  }

  write(path: string, data: string | Uint8Array): void {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    writeFileSync(join(this.dir, path), data);
  }

  remove(path: string): void {
    rmSync(join(this.dir, path), { recursive: true, force: true });
  }

  symlink(target: string, path: string): void {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    rmSync(join(this.dir, path), { force: true });
    symlinkSync(target, join(this.dir, path));
  }

  chmod(path: string, mode: number): void {
    chmodSync(join(this.dir, path), mode);
  }

  /** Stages everything and commits. `tick` is how far the clock moves first; 0 makes a tie. */
  commit(message: string, tick = 60): ObjectId {
    this.clock += tick;
    this.run("add", "-A");
    this.run("commit", "-q", "--allow-empty", "-m", message);
    return this.rev("HEAD");
  }

  rev(name: string): ObjectId {
    return this.run("rev-parse", "--verify", name);
  }

  tree(name: string): ObjectId {
    return this.rev(`${name}^{tree}`);
  }

  lines(...args: string[]): string[] {
    const out = this.run(...args);
    return out === "" ? [] : out.split("\n");
  }
}

/**
 * Every object of the repository in a `MemoryObjectStore`, read through one
 * `git cat-file --batch`. This is the `ObjectReader` the tests hand to the
 * package: it knows nothing of the repository on disk.
 */
export function loadStore(repo: Repo | string): MemoryObjectStore {
  const cwd = typeof repo === "string" ? repo : repo.dir;
  const buffer = gitRaw(["cat-file", "--batch-all-objects", "--batch", "--unordered"], {
    cwd,
  }).stdout;
  const store = new MemoryObjectStore();
  let at = 0;
  while (at < buffer.length) {
    const newline = buffer.indexOf(10, at);
    const [oid, type, size] = buffer.subarray(at, newline).toString("latin1").split(" ");
    const start = newline + 1;
    const end = start + Number(size);
    store.set(oid!, {
      type: type as ObjectType,
      data: new Uint8Array(buffer.subarray(start, end)),
    });
    // The content is followed by one newline that is not part of it.
    at = end + 1;
  }
  return store;
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
];

/** A line that looks like source: indented, and sometimes a brace or a blank, so the heuristics have work to do. */
export function sourceLine(next: () => number): string {
  const kind = next() % 12;
  if (kind === 0) return "";
  if (kind === 1) return `${"  ".repeat(next() % 3)}}`;
  if (kind === 2) return `function ${WORDS[next() % WORDS.length]}() {`;
  const words: string[] = [];
  const count = 1 + (next() % 5);
  for (let i = 0; i < count; i++) words.push(WORDS[next() % WORDS.length]!);
  return `${"  ".repeat(next() % 4)}${words.join(" ")};`;
}

export function sourceFile(next: () => number, lines: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) out.push(sourceLine(next));
  return out;
}

/** Edits a file's lines in place the way a commit does: a few inserts, deletes and replacements. */
export function editLines(lines: string[], next: () => number, edits = 1 + (next() % 4)): void {
  for (let e = 0; e < edits; e++) {
    const at = lines.length === 0 ? 0 : next() % lines.length;
    const kind = next() % 4;
    if (kind === 0 || lines.length < 5) {
      const added = sourceFile(next, 1 + (next() % 4));
      lines.splice(at, 0, ...added);
    } else if (kind === 1) lines.splice(at, 1 + (next() % 3));
    else if (kind === 2) lines[at] = sourceLine(next);
    else {
      // Move a block, which is where diff heuristics have real choices.
      const moved = lines.splice(at, 1 + (next() % 5));
      lines.splice(lines.length === 0 ? 0 : next() % lines.length, 0, ...moved);
    }
  }
}

export function text(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export interface HistoryFixture {
  readonly repo: Repo;
  /** Every commit, oldest first. */
  readonly commits: ObjectId[];
}

/**
 * A history with what makes walking it interesting: several files in
 * directories, edits, additions, deletions, renames with and without an
 * edit, side branches merged back, and commits that share a timestamp.
 */
export function makeHistory(seed: number, steps: number): HistoryFixture {
  const next = prng(seed);
  const repo = new Repo("history");
  const files = new Map<string, string[]>();
  const dirs = ["src", "src/lib", "docs", "tools"];
  for (let i = 0; i < 8; i++) {
    const path = `${dirs[i % dirs.length]}/file-${i}.txt`;
    files.set(path, sourceFile(next, 30 + (next() % 60)));
    repo.write(path, text(files.get(path)!));
  }
  repo.commit("initial");
  let counter = 100;
  let branches = 0;

  const mutate = (): void => {
    const paths = [...files.keys()];
    const action = next() % 20;
    const pick = paths[next() % paths.length]!;
    if (action < 12 || paths.length < 4) {
      const lines = files.get(pick)!;
      editLines(lines, next);
      repo.write(pick, text(lines));
    } else if (action < 14) {
      const path = `${dirs[next() % dirs.length]}/new-${counter++}.txt`;
      files.set(path, sourceFile(next, 10 + (next() % 40)));
      repo.write(path, text(files.get(path)!));
    } else if (action < 15) {
      files.delete(pick);
      repo.remove(pick);
    } else if (action < 18) {
      // A rename, half of the time with a small edit so it is found by similarity.
      const to = `${dirs[next() % dirs.length]}/moved-${counter++}.txt`;
      const lines = files.get(pick)!;
      files.delete(pick);
      repo.remove(pick);
      if (next() % 2 === 0) editLines(lines, next, 1);
      files.set(to, lines);
      repo.write(to, text(lines));
    } else {
      const lines = files.get(pick)!;
      editLines(lines, next, 2);
      repo.write(pick, text(lines));
      const other = paths[next() % paths.length]!;
      const more = files.get(other);
      if (more && other !== pick) {
        editLines(more, next, 1);
        repo.write(other, text(more));
      }
    }
  };

  // The working files of each branch are whatever is checked out, so re-read state by resetting the map.
  const reload = (): void => {
    files.clear();
    for (const path of repo.lines("ls-files")) {
      const content = repo.raw(["show", `HEAD:${path}`]).stdout.toString("utf8");
      files.set(path, content === "" ? [] : content.replace(/\n$/, "").split("\n"));
    }
  };

  for (let step = 1; step < steps; step++) {
    if (step % 11 === 5 && step + 6 < steps) {
      // A side branch from a few commits back, a couple of commits on it, then a merge.
      const name = `side-${branches++}`;
      const back = 1 + (next() % 4);
      repo.run("checkout", "-q", "-b", name, `HEAD~${Math.min(back, step - 1)}`);
      reload();
      const count = 1 + (next() % 3);
      for (let k = 0; k < count; k++) {
        mutate();
        repo.commit(`${name} change ${k}`, next() % 3 === 0 ? 0 : 30);
      }
      repo.run("checkout", "-q", "main");
      repo.clock += 10;
      const merged = repo.raw(
        ["merge", "-q", "--no-ff", "-X", "ours", "-m", `merge ${name}`, name],
        {
          allowFailure: true,
        },
      );
      if (merged.status !== 0) {
        // A conflict `-X ours` cannot settle (a file changed on one side, deleted on the other):
        // the changed file is in the working tree, and staging it settles it.
        repo.run("add", "-A");
        repo.run("commit", "-q", "--no-edit");
      }
      reload();
      continue;
    }
    mutate();
    repo.commit(`change ${step}`, next() % 4 === 0 ? 0 : 60);
  }
  return { repo, commits: repo.lines("rev-list", "--reverse", "--all") };
}
