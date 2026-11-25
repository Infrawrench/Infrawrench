/**
 * Test harness: a real TCP listener in front of `serveConnection`, keys from
 * the real `ssh-keygen`, and the real `ssh` and `git` binaries as clients.
 * Everything stays on 127.0.0.1.
 */
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import {
  loadHostKey,
  parseAuthorizedKey,
  serveConnection,
  type AuthorizedKey,
  type ExecChannel,
  type HostKey,
  type SshConnectionSummary,
  type SshServerLimits,
  type SshServerOptions,
} from "../src/index";

const run = promisify(execFile);

function hasBinary(name: string, args: string[]): boolean {
  return spawnSync(name, args, { stdio: "ignore" }).error === undefined;
}

/**
 * Most of the suite drives the real `ssh`, `ssh-keygen` and `git`. Where one
 * is missing those tests are skipped, and say so, rather than fail for a
 * reason that has nothing to do with the server.
 */
export const MISSING_TOOLS = [
  hasBinary("ssh", ["-V"]) ? null : "ssh",
  hasBinary("ssh-keygen", ["-?"]) ? null : "ssh-keygen",
  hasBinary("git", ["--version"]) ? null : "git",
].filter((name) => name !== null);

if (MISSING_TOOLS.length > 0) {
  console.warn(`skipping tests that need: ${MISSING_TOOLS.join(", ")} (not installed)`);
}

export interface Workspace {
  readonly dir: string;
  path(...parts: string[]): string;
  cleanup(): Promise<void>;
}

export async function createWorkspace(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "git-ssh-test-"));
  return {
    dir,
    path: (...parts) => join(dir, ...parts),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export interface KeyPair {
  /** Path of the private key file. */
  readonly path: string;
  readonly privateKey: string;
  readonly publicLine: string;
  readonly publicKey: AuthorizedKey;
}

export async function generateKey(
  workspace: Workspace,
  name: string,
  type: "ed25519" | "ecdsa" | "rsa",
  bits?: number,
): Promise<KeyPair> {
  const path = workspace.path(name);
  const args = ["-q", "-t", type, "-N", "", "-C", `${name}@test`, "-f", path];
  if (bits !== undefined) args.push("-b", String(bits));
  await run("ssh-keygen", args);
  const publicLine = (await readFile(`${path}.pub`, "utf8")).trim();
  const publicKey = await parseAuthorizedKey(publicLine);
  if (!publicKey) throw new Error(`parseAuthorizedKey refused a key from ssh-keygen: ${name}`);
  return { path, privateKey: await readFile(path, "utf8"), publicLine, publicKey };
}

export type ExecHandler = (
  principal: string,
  command: string,
  channel: ExecChannel,
  env: ReadonlyMap<string, string>,
) => Promise<number>;

export interface TestServerOptions {
  readonly hostKey: HostKey | string;
  /** Fingerprint to principal. */
  readonly users: ReadonlyMap<string, string>;
  readonly exec: ExecHandler;
  readonly limits?: SshServerLimits;
  readonly overrides?: Partial<SshServerOptions<string>>;
}

export interface TestServer {
  readonly port: number;
  /** One entry per finished connection, in the order they ended. */
  readonly summaries: SshConnectionSummary[];
  readonly errors: unknown[];
  /** Every `authenticate` call the server made. */
  readonly lookups: Array<{ user: string; fingerprint: string; algorithm: string; phase: string }>;
  /**
   * Resolves with the summary of the next connection to be accepted, once it
   * has ended. Call it before connecting; connections that were already open
   * finish in their own time and are not mistaken for it.
   */
  nextSummary(): Promise<SshConnectionSummary>;
  close(): Promise<void>;
}

/** Adapt a Node socket to the pair of Web Streams the server takes, as the Worker's socket already is. */
function toDuplex(socket: Socket) {
  return {
    readable: Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>,
    writable: Writable.toWeb(socket) as unknown as WritableStream<Uint8Array>,
  };
}

export async function startServer(options: TestServerOptions): Promise<TestServer> {
  const hostKey =
    typeof options.hostKey === "string" ? await loadHostKey(options.hostKey) : options.hostKey;
  const summaries: SshConnectionSummary[] = [];
  const errors: unknown[] = [];
  const lookups: TestServer["lookups"] = [];
  const claims: Array<(summary: SshConnectionSummary) => void> = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // The stream adapters report socket errors; an unhandled 'error' event would crash the test.
    socket.on("error", () => {});
    const claim = claims.shift();
    void serveConnection<string>(toDuplex(socket), {
      hostKeys: [hostKey],
      authenticate: async (user, key, phase) => {
        lookups.push({ user, fingerprint: key.fingerprint, algorithm: key.algorithm, phase });
        return options.users.get(key.fingerprint) ?? null;
      },
      exec: options.exec,
      shellGreeting: (principal) =>
        `Hi ${principal}! You've successfully authenticated, but shell access is not provided.\n`,
      ...(options.limits ? { limits: options.limits } : {}),
      onError: (error) => errors.push(error),
      onClose: (summary) => {
        summaries.push(summary);
        claim?.(summary);
      },
      ...options.overrides,
    }).catch((error: unknown) => errors.push(error));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    port: (server.address() as AddressInfo).port,
    summaries,
    errors,
    lookups,
    nextSummary: () => new Promise((resolve) => claims.push(resolve)),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * The options every test client gets: no config file, no known_hosts, no
 * agent, only the given key. `extra` goes first because ssh keeps the first
 * value it is given for an option.
 */
export function sshOptions(port: number, keyPath: string, extra: readonly string[] = []): string[] {
  return [
    "-F",
    "/dev/null",
    ...extra,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "BatchMode=yes",
    "-o",
    "LogLevel=ERROR",
    "-i",
    keyPath,
    "-p",
    String(port),
  ];
}

export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
}

export function collect(child: ChildProcess, input?: Uint8Array | string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }),
    );
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

/** Run the real `ssh` against a test server. */
export function ssh(
  port: number,
  keyPath: string,
  args: readonly string[],
  input?: Uint8Array | string,
): Promise<ProcessResult> {
  const extra = args.slice(0, -1);
  const command = args[args.length - 1];
  const argv = [...sshOptions(port, keyPath, extra), "git@127.0.0.1"];
  if (command !== undefined && command !== "") argv.push(command);
  return collect(spawn("ssh", argv, { stdio: ["pipe", "pipe", "pipe"] }), input);
}

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the real `git`, with its SSH transport pointed at a test server. */
export async function git(
  cwd: string,
  args: readonly string[],
  client?: { port: number; keyPath: string; ssh?: readonly string[] },
): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  // Tests must not pick up the developer's agent or protocol settings.
  delete env.SSH_AUTH_SOCK;
  delete env.GIT_PROTOCOL;
  if (client) {
    env.GIT_SSH_COMMAND = ["ssh", ...sshOptions(client.port, client.keyPath, client.ssh)].join(" ");
  }
  const { stdout, stderr } = await run("git", [...args], {
    cwd,
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout, stderr };
}

/**
 * An `exec` handler that runs the real `git upload-pack` / `git receive-pack`
 * against repositories under `root`, the way the Worker will run its own
 * implementation. `seen` records every command and its environment.
 */
export function gitExecHandler(
  root: string,
  seen: Array<{ command: string; env: Map<string, string> }> = [],
): ExecHandler {
  return async (_principal, command, channel, env) => {
    seen.push({ command, env: new Map(env) });
    const match = /^(git-upload-pack|git-receive-pack) '\/?([A-Za-z0-9._/-]+)'$/.exec(command);
    if (!match || match[2]!.includes("..")) {
      const writer = channel.stderr.getWriter();
      await writer.write(new TextEncoder().encode(`unknown command: ${command}\n`));
      await writer.close();
      return 128;
    }
    const service = match[1]!.slice("git-".length);
    const childEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
    delete childEnv.GIT_PROTOCOL;
    const protocol = env.get("GIT_PROTOCOL");
    if (protocol !== undefined) childEnv.GIT_PROTOCOL = protocol;
    const child = spawn("git", [service, join(root, match[2]!)], {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    channel.signal.addEventListener("abort", () => child.kill());
    const exited = new Promise<number>((resolve) =>
      child.on("close", (code) => resolve(code ?? 1)),
    );
    const stdin = Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>;
    const stdout = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
    const stderr = Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>;
    const [status] = await Promise.all([
      exited,
      // The child closing its stdin early (a refused push) is not a failure of the pipe.
      channel.stdin.pipeTo(stdin).catch(() => {}),
      stdout.pipeTo(channel.stdout),
      stderr.pipeTo(channel.stderr),
    ]);
    return status;
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
