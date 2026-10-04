import type { CircleContext } from "../api.js";

export interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Reply {
  status?: number;
  body?: unknown;
  /** Raw bytes for binary downloads. */
  raw?: Uint8Array;
}

/**
 * Fake host HTTP service. `route` gets each request (URL parsed, JSON body
 * decoded) and returns either a bare JSON body or a `Reply`. A reply is
 * recognised by `status`, `body` or `raw` keys alongside nothing else.
 */
export function makeHttp(route: (call: Call) => unknown) {
  const calls: Call[] = [];
  const http = {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
      responseEncoding?: "utf8" | "binary";
    }) {
      const call: Call = {
        url: new URL(req.url),
        method: req.method,
        headers: req.headers,
        body: req.body ? JSON.parse(String(req.body)) : undefined,
      };
      calls.push(call);
      const out = route(call);
      const isReply =
        out !== null &&
        typeof out === "object" &&
        !Array.isArray(out) &&
        Object.keys(out).length > 0 &&
        Object.keys(out).every((k) => k === "status" || k === "body" || k === "raw");
      const reply: Reply = isReply ? (out as Reply) : { body: out };
      const text =
        typeof reply.body === "string"
          ? reply.body
          : reply.body === undefined
            ? ""
            : JSON.stringify(reply.body);
      return {
        status: reply.status ?? 200,
        headers: {},
        body: req.responseEncoding === "binary" ? "" : text,
        ...(req.responseEncoding === "binary"
          ? { rawBody: reply.raw ?? new TextEncoder().encode(text) }
          : {}),
      };
    },
  };
  return { http, calls };
}

export function ctxWith(http: ReturnType<typeof makeHttp>["http"]): CircleContext {
  return { token: "TEST_TOKEN", http };
}

export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const noSleep = async () => {};
