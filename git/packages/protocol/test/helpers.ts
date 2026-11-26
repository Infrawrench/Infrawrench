/**
 * Runs the protocol where the real `git` can reach it: a Node HTTP server
 * for the stateless form and a TCP server (behind a stand-in for `ssh`) for
 * the stateful one. Everything stays on 127.0.0.1.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { type Server as HttpServer, createServer as createHttpServer } from "node:http";
import { type Server as NetServer, type Socket, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe } from "vitest";
import {
  type GitServiceName,
  type ReceiveHooks,
  type RepositoryBackend,
  type ServeStats,
  advertisementContentType,
  httpServeRequest,
  infoRefsPreamble,
  isGitService,
  newServeStats,
  parseGitProtocol,
  resultContentType,
  serve,
} from "../src";

export const hasGit = spawnSync("git", ["--version"]).status === 0;
if (!hasGit) console.warn("git-protocol: no git binary on PATH, the interop tests are skipped");
export const describeGit = describe.skipIf(!hasGit) as typeof describe;

const roots: string[] = [];

export function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `git-protocol-${label}-`));
  roots.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
}

const SSH_HELPER = fileURLToPath(new URL("./ssh-helper.mjs", import.meta.url));

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
  GIT_SSH_COMMAND: `node ${SSH_HELPER}`,
  // Without this git treats an unknown ssh as one that cannot carry GIT_PROTOCOL.
  GIT_SSH_VARIANT: "ssh",
  TZ: "UTC",
};

export interface GitOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly allowFailure?: boolean;
  readonly input?: string;
}

export interface GitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs git without blocking the event loop. The server under test lives in
 * this process, so a synchronous spawn would wait for an answer that can
 * never be written.
 */
export function git(args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      env: { ...ENV, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
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
        reject(new Error(`git ${args.join(" ")} exited ${result.status}: ${result.stderr}`));
      } else {
        resolve(result);
      }
    });
    // A git that refuses and exits before it has read its input closes the
    // pipe under the write: EPIPE on Linux. The exit status is the answer,
    // and `close` reports it; without a listener the error is uncaught.
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
}

/** Runs git and returns its stdout. */
export async function gitOut(args: readonly string[], options: GitOptions = {}): Promise<string> {
  return (await git(args, options)).stdout;
}

export interface ServedRequest {
  readonly transport: "http" | "stream";
  readonly service: GitServiceName;
  readonly version: number;
  readonly advertiseOnly: boolean;
  readonly stats: ServeStats;
}

export interface TestServer {
  /** `http://127.0.0.1:<port>/repo.git` */
  readonly httpUrl: string;
  /** `ssh://git@127.0.0.1:<port>/repo.git`, served statefully through the ssh stand-in. */
  readonly streamUrl: string;
  /** One entry per request served, oldest first. */
  readonly requests: ServedRequest[];
  /** Errors that were not the client's doing. A test expects none. */
  readonly errors: unknown[];
  hooks: ReceiveHooks | undefined;
  close(): Promise<void>;
}

/**
 * A socket's incoming bytes as a stream that leaves the socket alone when it
 * is cancelled. `Readable.toWeb` destroys the socket on cancel, and the
 * protocol cancels its input as soon as it has said its last word, which
 * would cut that word off.
 */
function socketInput(socket: Socket): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      socket.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      socket.on("end", () => {
        try {
          controller.close();
        } catch {
          // Already cancelled.
        }
      });
      socket.resume();
    },
    cancel() {
      socket.removeAllListeners("data");
      socket.resume();
    },
  });
}

function listen(server: HttpServer | NetServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

export async function startServer(backend: RepositoryBackend): Promise<TestServer> {
  const requests: ServedRequest[] = [];
  const errors: unknown[] = [];
  const sockets = new Set<Socket>();
  const state: { hooks: ReceiveHooks | undefined } = { hooks: undefined };
  const onError = (error: unknown): void => {
    errors.push(error);
  };

  const http = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const gitProtocol = req.headers["git-protocol"] as string | undefined;
    const pipe = (stream: ReadableStream<Uint8Array>): void => {
      Readable.fromWeb(stream as import("node:stream/web").ReadableStream).pipe(res);
    };
    if (req.method === "GET" && url.pathname.endsWith("/info/refs")) {
      const service = url.searchParams.get("service");
      if (!isGitService(service)) {
        res.writeHead(400).end();
        return;
      }
      const request = httpServeRequest(service, gitProtocol, true);
      const stats = newServeStats();
      requests.push({
        transport: "http",
        service,
        version: request.version,
        advertiseOnly: true,
        stats,
      });
      res.writeHead(200, { "Content-Type": advertisementContentType(service) });
      res.write(infoRefsPreamble(request));
      pipe(serve({ backend, request, input: [], stats, onError }));
      return;
    }
    const service = url.pathname.split("/").pop();
    if (req.method === "POST" && isGitService(service)) {
      const request = httpServeRequest(service, gitProtocol, false);
      const stats = newServeStats();
      requests.push({
        transport: "http",
        service,
        version: request.version,
        advertiseOnly: false,
        stats,
      });
      let input = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
      if (req.headers["content-encoding"] === "gzip") {
        input = input.pipeThrough(new DecompressionStream("gzip") as never);
      }
      res.writeHead(200, { "Content-Type": resultContentType(service) });
      pipe(
        serve({
          backend,
          request,
          input,
          stats,
          onError,
          ...(state.hooks ? { hooks: state.hooks } : {}),
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  // Half-open: git may finish talking before it has heard the whole answer.
  const net = createNetServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    // The stand-in's first line says which command git asked `ssh` to run.
    let header = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      header = Buffer.concat([header, chunk]);
      const newline = header.indexOf(0x0a);
      if (newline < 0) return;
      socket.off("data", onData);
      socket.pause();
      const { command, protocol } = JSON.parse(header.subarray(0, newline).toString("utf8")) as {
        command: string;
        protocol: string;
      };
      socket.unshift(header.subarray(newline + 1));
      const service = command.split(" ")[0];
      if (!isGitService(service)) {
        socket.destroy();
        return;
      }
      const asked = parseGitProtocol(protocol);
      const version = service === "git-receive-pack" && asked === 2 ? 0 : asked;
      const stats = newServeStats();
      requests.push({ transport: "stream", service, version, advertiseOnly: false, stats });
      const output = serve({
        backend,
        request: { service, version, statelessRpc: false, advertiseOnly: false },
        input: socketInput(socket),
        stats,
        onError,
        ...(state.hooks ? { hooks: state.hooks } : {}),
      });
      Readable.fromWeb(output as import("node:stream/web").ReadableStream)
        .on("error", () => socket.destroy())
        .pipe(socket);
    };
    socket.on("data", onData);
  });

  const [httpPort, netPort] = await Promise.all([listen(http), listen(net)]);
  return {
    httpUrl: `http://127.0.0.1:${httpPort}/repo.git`,
    streamUrl: `ssh://git@127.0.0.1:${netPort}/repo.git`,
    requests,
    errors,
    get hooks() {
      return state.hooks;
    },
    set hooks(value) {
      state.hooks = value;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      http.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => http.close(resolve)),
        new Promise((resolve) => net.close(resolve)),
      ]);
    },
  };
}

let clock = 1_700_000_000;

/** Starts the commit clock again, so each test's history has the same dates. */
export function resetClock(): void {
  clock = 1_700_000_000;
}

/** The next tick of the commit clock, as git wants a date. */
export function nextDate(): string {
  clock += 60;
  return `${clock} +0000`;
}

/** Commits a file in a work tree, each commit a minute after the last. Returns the commit id. */
export async function commitFile(
  cwd: string,
  path: string,
  content: string,
  message: string,
): Promise<string> {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), content);
  const date = nextDate();
  const env = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  await git(["add", "-A"], { cwd, env });
  await git(["commit", "-q", "-m", message], { cwd, env });
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
