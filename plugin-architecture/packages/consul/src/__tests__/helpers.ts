import { afterEach, beforeEach, vi } from "vitest";

/** The part of `node:net` this needs; the package has no Node types to name it with. */
interface NetModule {
  Socket: { prototype: { connect: (...args: unknown[]) => unknown } };
}
const NODE_NET = "node:net";

/**
 * Fails a test that gets past the fake transport, rather than let it reach a real
 * Consul agent. A test that means to go through `fetch` stubs it again itself.
 */
export function blockNetwork(): void {
  const refuse = (): never => {
    throw new Error("A test reached for the network");
  };
  beforeEach(async () => {
    const net: NetModule = await import(/* @vite-ignore */ NODE_NET);
    vi.stubGlobal("fetch", refuse);
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(refuse);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}

export interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Reply {
  status?: number;
  body?: unknown;
  text?: string;
  /** Response headers, as the host hands them on. */
  headers?: Record<string, string>;
}

/**
 * Fake host HTTP service. `route` gets each request (URL parsed, JSON body
 * decoded when it is JSON) and returns a bare JSON body or a `Reply`.
 */
export function makeHttp(route: (call: Call) => unknown) {
  const calls: Call[] = [];
  const http = {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
    }) {
      let body: unknown = req.body;
      if (typeof req.body === "string") {
        try {
          body = JSON.parse(req.body);
        } catch {
          body = req.body;
        }
      }
      const call: Call = { url: new URL(req.url), method: req.method, headers: req.headers, body };
      calls.push(call);
      const out = route(call);
      const isReply =
        out !== null &&
        typeof out === "object" &&
        !Array.isArray(out) &&
        Object.keys(out).length > 0 &&
        Object.keys(out).every(
          (k) => k === "status" || k === "body" || k === "text" || k === "headers",
        );
      const reply: Reply = isReply ? (out as Reply) : { body: out };
      return {
        status: reply.status ?? 200,
        headers: reply.headers ?? {},
        body: reply.text ?? (reply.body === undefined ? "" : JSON.stringify(reply.body)),
      };
    },
  };
  return { http, calls };
}
