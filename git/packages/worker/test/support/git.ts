/** Drives the real `git` (and `ssh-keygen`) for the worker's tests. Nothing here leaves 127.0.0.1. */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const hasGit = spawnSync("git", ["--version"]).status === 0;

const roots: string[] = [];

export function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `git-worker-${label}-`));
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
  readonly env?: Record<string, string>;
  readonly allowFailure?: boolean;
}

export interface GitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command without blocking the event loop: the server under test may live in this process. */
export function run(
  command: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...ENV, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        status: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8").trim(),
        stderr: Buffer.concat(err).toString("utf8"),
      };
      if (result.status !== 0 && !options.allowFailure) {
        reject(new Error(`${command} ${args.join(" ")} exited ${result.status}: ${result.stderr}`));
      } else {
        resolve(result);
      }
    });
  });
}

export const git = (args: readonly string[], options: GitOptions = {}): Promise<GitResult> =>
  run("git", args, options);

export async function gitOut(args: readonly string[], options: GitOptions = {}): Promise<string> {
  return (await git(args, options)).stdout;
}

let clock = 1_700_000_000;

export function resetClock(): void {
  clock = 1_700_000_000;
}

/** Commits a file in a work tree, each commit a minute after the last. Returns the commit id. */
export async function commitFile(
  cwd: string,
  path: string,
  content: string | Uint8Array,
  message: string,
): Promise<string> {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), content);
  clock += 60;
  const date = `${clock} +0000`;
  const env = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  await git(["add", "-A"], { cwd, env });
  // From a file, not `-m`: Linux refuses one argument over 128 KiB (E2BIG),
  // and the reader's bounds suite commits a message larger than that.
  const messageFile = join(cwd, ".git", "TEST_COMMIT_MSG");
  writeFileSync(messageFile, message);
  await git(["commit", "-q", "-F", messageFile], { cwd, env });
  return gitOut(["rev-parse", "HEAD"], { cwd });
}

/** A new work tree with `main` checked out and nothing committed. */
export async function initRepo(label: string): Promise<string> {
  const dir = tempDir(label);
  await git(["init", "-q", "-b", "main", dir]);
  return dir;
}

/** Every object reachable from every ref, sorted: what two repositories must agree on. */
export async function allObjects(cwd: string): Promise<string> {
  const out = await gitOut(["rev-list", "--objects", "--all", "--no-object-names"], { cwd });
  return out.split("\n").sort().join("\n");
}

/** Bytes that do not compress, so a pack of them is as large as they are. */
export function randomBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }
  return out;
}

/**
 * What a clone costs the server alone: a protocol v2 `fetch` of everything,
 * read to the end and thrown away. `git clone` spends most of its time in
 * its own `index-pack`, which says nothing about us.
 */
export async function downloadPack(
  repoUrl: string,
  wants: readonly string[],
  headers: Record<string, string> = {},
): Promise<{ seconds: number; bytes: number }> {
  const pkt = (line: string): string => (line.length + 4).toString(16).padStart(4, "0") + line;
  const body =
    pkt("command=fetch\n") +
    pkt("object-format=sha1\n") +
    "0001" +
    pkt("ofs-delta\n") +
    pkt("no-progress\n") +
    wants.map((oid) => pkt(`want ${oid}\n`)).join("") +
    pkt("done\n") +
    "0000";
  const started = performance.now();
  const response = await fetch(`${repoUrl}/git-upload-pack`, {
    method: "POST",
    headers: {
      "Git-Protocol": "version=2",
      "Content-Type": "application/x-git-upload-pack-request",
      ...headers,
    },
    body,
  });
  if (!response.ok || !response.body) throw new Error(`fetch answered ${response.status}`);
  let bytes = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
  }
  return { seconds: (performance.now() - started) / 1000, bytes };
}
