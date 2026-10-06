export interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Fake host HTTP service: `route` returns a JSON body or `{status, body, headers}`. */
export function makeHttp(route: (call: Call) => unknown) {
  const calls: Call[] = [];
  const http = {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
    }) {
      const call: Call = {
        url: new URL(req.url),
        method: req.method,
        headers: req.headers,
        body: req.body ? JSON.parse(String(req.body)) : undefined,
      };
      calls.push(call);
      const out = route(call) as
        { status?: number; body?: unknown; headers?: Record<string, string> } | unknown;
      const isReply =
        out !== null &&
        typeof out === "object" &&
        !Array.isArray(out) &&
        Object.keys(out as object).length > 0 &&
        Object.keys(out as object).every((k) => k === "status" || k === "body" || k === "headers");
      const reply = (isReply ? out : { body: out }) as {
        status?: number;
        body?: unknown;
        headers?: Record<string, string>;
      };
      return {
        status: reply.status ?? 200,
        headers: reply.headers ?? {},
        body:
          reply.body === undefined
            ? ""
            : typeof reply.body === "string"
              ? reply.body
              : JSON.stringify(reply.body),
      };
    },
  };
  return { http, calls };
}
