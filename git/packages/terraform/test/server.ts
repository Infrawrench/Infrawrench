import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { handleStateRequest, type StateAuth, type StateStore } from "../src/index.js";

/**
 * A loopback HTTP server in front of {@link handleStateRequest}, for the
 * tests that point the real `terraform` binary at it. It listens on
 * 127.0.0.1 only and nothing in the tests reaches any other address.
 */

export interface RequestRecord {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly bodyBytes: number;
}

export interface TestServer {
  /** `http://127.0.0.1:<port>/acme/infra/terraform/prod/state` */
  readonly stateUrl: string;
  /** `http://127.0.0.1:<port>/acme/infra/terraform/prod/runs/1/plan` */
  readonly planUrl: string;
  readonly requests: RequestRecord[];
  /** Bodies posted to the plan URL, parsed. */
  readonly plans: unknown[];
  close(): Promise<void>;
}

/** Passwords the server knows, as a host's access resolution would answer for them. */
export const TOKENS: Record<string, StateAuth> = {
  "writer-token": { principal: "ci:run-1", canRead: true, canWrite: true, canAdmin: false },
  "admin-token": { principal: "user:admin", canRead: true, canWrite: true, canAdmin: true },
  "reader-token": { principal: "user:reader", canRead: true, canWrite: false, canAdmin: false },
};

const NOBODY: StateAuth = { principal: null, canRead: false, canWrite: false, canAdmin: false };

function authOf(header: string | undefined): StateAuth {
  if (!header?.startsWith("Basic ")) return NOBODY;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  return TOKENS[decoded.slice(decoded.indexOf(":") + 1)] ?? NOBODY;
}

export async function startServer(store: StateStore): Promise<TestServer> {
  const requests: RequestRecord[] = [];
  const plans: unknown[] = [];
  const base = "/acme/infra/terraform/prod";

  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      void (async () => {
        const method = incoming.method ?? "GET";
        const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host}`);
        const body = Buffer.concat(chunks);
        const auth = authOf(incoming.headers.authorization);
        let response: Response;
        if (url.pathname === `${base}/runs/1/plan` && method === "POST") {
          if (auth.canWrite) plans.push(JSON.parse(body.toString("utf8")));
          response = new Response(null, { status: auth.canWrite ? 204 : 403 });
        } else if (url.pathname.startsWith(`${base}/state`)) {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (typeof value === "string") headers.set(name, value);
          }
          const hasBody = method !== "GET" && method !== "HEAD" && body.length > 0;
          response = await handleStateRequest(
            new Request(url, { method, headers, ...(hasBody ? { body } : {}) }),
            store,
            auth,
          );
        } else {
          response = new Response(null, { status: 404 });
        }
        requests.push({
          method,
          path: url.pathname + url.search,
          status: response.status,
          bodyBytes: body.length,
        });
        const payload = Buffer.from(await response.arrayBuffer());
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(method === "HEAD" ? undefined : payload);
      })().catch((error: unknown) => {
        outgoing.writeHead(500);
        outgoing.end(String(error));
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    stateUrl: `${origin}${base}/state`,
    planUrl: `${origin}${base}/runs/1/plan`,
    requests,
    plans,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
