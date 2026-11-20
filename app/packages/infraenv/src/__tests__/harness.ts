/**
 * Test plumbing: an in-memory `Io`, temporary directories (real paths, since
 * macOS's /var is a symlink), a temporary git repository, and a mock
 * Infrawrench API on 127.0.0.1. Nothing here reaches the network.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Io } from "../io";
import { run } from "../main";

const made: string[] = [];

export function tempDir(prefix = "infraenv-test-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Keep the developer's own git config (a global core.hooksPath, say) out of
 * the tests: every git the code under test runs inherits process.env.
 */
export function isolateGit(): void {
  const empty = join(tempDir("infraenv-gitconfig-"), "gitconfig");
  writeFileSync(empty, "");
  process.env.GIT_CONFIG_GLOBAL = empty;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
}

export function gitInit(dir = tempDir("infraenv-repo-")): string {
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

export interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

export interface RunOptions {
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
  readonly home?: string;
  readonly stdin?: string;
}

/** Run one command line in-process and capture what it printed. */
export async function runCli(argv: readonly string[], options: RunOptions): Promise<Captured> {
  let out = "";
  let err = "";
  const stdin = Readable.from(options.stdin === undefined ? [] : [options.stdin]);
  const io: Io = {
    cwd: options.cwd,
    // An empty PATH (plus git's directory) unless a test gives one, so the
    // developer's own `infrawrench` is never found and run.
    env: { PATH: "", ...options.env },
    home: options.home ?? tempDir("infraenv-home-"),
    platform: process.platform,
    out: (text) => void (out += text),
    err: (text) => void (err += text),
    stdin: stdin as unknown as NodeJS.ReadStream,
    color: false,
    errColor: false,
  };
  const code = await run(argv, () => io);
  return { code, out, err };
}

export interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

export type Handler = (
  request: Recorded,
) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

export interface MockApi {
  readonly url: string;
  readonly requests: Recorded[];
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (text += chunk));
    request.on("end", () => done(text));
  });
}

/** A local server answering by `METHOD /path`; anything unrouted is a 404. */
export async function mockApi(routes: Record<string, Handler>): Promise<MockApi> {
  const requests: Recorded[] = [];
  const server: Server = createServer(async (request, response) => {
    const text = await readBody(request);
    const recorded: Recorded = {
      method: request.method ?? "GET",
      path: request.url ?? "/",
      authorization: request.headers.authorization,
      body: text ? (JSON.parse(text) as unknown) : null,
    };
    requests.push(recorded);
    const handler = routes[`${recorded.method} ${recorded.path}`];
    const answer = handler
      ? await handler(recorded)
      : { status: 404, body: { error: "Not found" } };
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

export const ORG = "0b9c5f62-1f0a-4a55-9d7e-3a0f6c1b2d34";
export const OTHER_ORG = "7d1e2c3b-4a59-4f68-8e7d-6c5b4a392817";
export const KEY = "iwk_fake_test_key";

export const whoamiRoute =
  (org = ORG): Handler =>
  () => ({
    status: 200,
    body: { userId: "user_1", organizationId: org, principal: "api_key" },
  });
