import net from "node:net";
import { afterEach, beforeEach, vi } from "vitest";
import type { CoralogixContext } from "../api.js";
import { resolveRegion } from "../regions.js";

export interface Reply {
  status?: number;
  body?: unknown;
}

export interface Recorded {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * Fails a test that gets past the fake transport, rather than let it reach the
 * provider's production API.
 */
export function blockNetwork(): void {
  const refuse = (): never => {
    throw new Error("A test reached for the network");
  };
  beforeEach(() => {
    vi.stubGlobal("fetch", refuse);
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(refuse);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}

/**
 * Fake host HTTP service. `jsonRestFetch` always prefers it when present, so
 * requests are exercised end to end (URL, auth header, body) offline.
 */
export function makeHttp(route: (url: URL, method: string, body: unknown) => Reply) {
  const calls: Recorded[] = [];
  const http = {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
    }) {
      const url = new URL(req.url);
      const body =
        typeof req.body === "string" && req.body.length > 0 ? JSON.parse(req.body) : undefined;
      calls.push({ url, method: req.method, headers: req.headers, body });
      const reply = route(url, req.method, body);
      const text = reply.body === undefined ? "" : JSON.stringify(reply.body);
      return { status: reply.status ?? 200, headers: {}, body: text };
    },
  };
  return { http, calls };
}

export function ctxWith(
  http: ReturnType<typeof makeHttp>["http"],
  region = "eu2",
): CoralogixContext {
  return { apiKey: "test-key", region: resolveRegion(region), http };
}
