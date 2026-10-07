export interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Fake host HTTP service. `route` gets each request and returns either a bare
 * JSON body or a `Reply` (recognised by having only status/body/headers keys).
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
      let body: unknown;
      if (req.body) {
        try {
          body = JSON.parse(String(req.body));
        } catch {
          body = String(req.body);
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
        Object.keys(out).every((k) => k === "status" || k === "body" || k === "headers");
      const reply: Reply = isReply ? (out as Reply) : { body: out };
      const text =
        typeof reply.body === "string"
          ? reply.body
          : reply.body === undefined
            ? ""
            : JSON.stringify(reply.body);
      return { status: reply.status ?? 200, headers: reply.headers ?? {}, body: text };
    },
  };
  return { http, calls };
}
