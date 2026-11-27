/**
 * A real Git host on 127.0.0.1 for the push client's tests: bare
 * repositories served by `git http-backend` (git's own smart HTTP CGI)
 * behind a Node HTTP server that asks for Basic credentials.
 *
 * Nothing of ours is on the far side, so a push that lands here landed the
 * way it would on any Git host.
 */
import { spawn } from "node:child_process";
import { type IncomingMessage, type Server, createServer } from "node:http";

export interface BackendRequest {
  readonly method: string;
  /** Path and query, as asked. */
  readonly url: string;
  readonly authorization: string | null;
  readonly status: number;
}

export interface HttpBackend {
  /** `http://127.0.0.1:<port>`; a repository is `<origin>/<name>.git`. */
  readonly origin: string;
  /** One entry per request, oldest first. */
  readonly requests: BackendRequest[];
  /** Changes what the next requests are answered with, for one test. */
  behave(behaviour: Partial<Behaviour>): void;
  close(): Promise<void>;
}

interface Behaviour {
  /** Answer every request with this status instead of serving it. */
  status: number | null;
  /** Answer every request with a redirect to this address. */
  redirect: string | null;
  /** Called with the bytes of each push's body before git reads them. */
  onPush: ((bytes: number) => void) | null;
  /** Called before a push is handed to git, which waits for it. */
  beforePush: (() => Promise<void>) | null;
}

export interface HttpBackendOptions {
  /** The directory the bare repositories are in. */
  readonly root: string;
  readonly username: string;
  readonly password: string;
}

const basic = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

/** Splits a CGI answer into its headers and where its body starts. */
function cgiHead(buffer: Buffer): { headers: Map<string, string>; bodyAt: number } | null {
  let end = buffer.indexOf("\r\n\r\n");
  let gap = 4;
  if (end < 0) {
    end = buffer.indexOf("\n\n");
    gap = 2;
  }
  if (end < 0) return null;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, end).toString("latin1").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headers, bodyAt: end + gap };
}

export async function startHttpBackend(options: HttpBackendOptions): Promise<HttpBackend> {
  const requests: BackendRequest[] = [];
  const behaviour: Behaviour = { status: null, redirect: null, onPush: null, beforePush: null };
  const expected = basic(options.username, options.password);

  const serve = async (req: IncomingMessage, res: import("node:http").ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const authorization = (req.headers.authorization as string | undefined) ?? null;
    const done = (status: number): void => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", authorization, status });
    };
    if (behaviour.redirect !== null) {
      req.resume();
      res.writeHead(302, { location: behaviour.redirect }).end();
      done(302);
      return;
    }
    if (behaviour.status !== null) {
      req.resume();
      res.writeHead(behaviour.status, { "content-type": "text/plain" }).end("no\n");
      done(behaviour.status);
      return;
    }
    if (authorization !== expected) {
      req.resume();
      res
        .writeHead(401, { "www-authenticate": 'Basic realm="test"', "content-type": "text/plain" })
        .end("credentials\n");
      done(401);
      return;
    }
    const push = req.method === "POST" && url.pathname.endsWith("/git-receive-pack");
    if (push && behaviour.beforePush) await behaviour.beforePush();
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH,
        HOME: "/nonexistent",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_PROJECT_ROOT: options.root,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: req.method ?? "GET",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: (req.headers["content-type"] as string | undefined) ?? "",
        // A request with a known length says so; a streamed one is read to its end.
        ...(req.headers["content-length"] !== undefined
          ? { CONTENT_LENGTH: req.headers["content-length"] }
          : { HTTP_TRANSFER_ENCODING: "chunked" }),
        ...(req.headers["git-protocol"] !== undefined
          ? { GIT_PROTOCOL: req.headers["git-protocol"] as string }
          : {}),
        // An authenticated user is what lets http-backend take a push.
        REMOTE_USER: options.username,
        REMOTE_ADDR: "127.0.0.1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let seen = 0;
    req.on("data", (chunk: Buffer) => {
      seen += chunk.length;
    });
    req.on("end", () => {
      if (push) behaviour.onPush?.(seen);
    });
    child.stdin.on("error", () => {});
    req.pipe(child.stdin);
    let pending: Buffer | null = Buffer.alloc(0);
    let status = 200;
    child.stdout.on("data", (chunk: Buffer) => {
      if (pending === null) {
        res.write(chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      const head = cgiHead(pending);
      if (!head) return;
      const said = head.headers.get("status");
      status = said ? Number.parseInt(said, 10) : 200;
      head.headers.delete("status");
      res.writeHead(status, Object.fromEntries(head.headers));
      res.write(pending.subarray(head.bodyAt));
      pending = null;
    });
    child.on("close", () => {
      if (pending !== null) {
        status = 500;
        res.writeHead(500).end();
      } else {
        res.end();
      }
      done(status);
    });
  };

  const server: Server = createServer((req, res) => {
    void serve(req, res);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    behave(next) {
      Object.assign(behaviour, next);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
