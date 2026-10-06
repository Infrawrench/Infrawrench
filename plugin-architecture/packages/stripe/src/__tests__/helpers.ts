export interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  /** Raw request body (form-encoded for v1, JSON text for v2). */
  rawBody: string;
  /** v1 form body decoded, or v2 JSON parsed. */
  form: URLSearchParams;
  json: unknown;
}

export interface Reply {
  status?: number;
  body?: unknown;
}

/** Fake host HTTP service: `route` returns a JSON body or a `{status, body}` reply. */
export function makeHttp(route: (call: Call) => unknown) {
  const calls: Call[] = [];
  const http = {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
    }) {
      const rawBody = req.body ? String(req.body) : "";
      let json: unknown;
      if (rawBody && req.headers["Content-Type"] === "application/json") json = JSON.parse(rawBody);
      const call: Call = {
        url: new URL(req.url),
        method: req.method,
        headers: req.headers,
        rawBody,
        form: new URLSearchParams(json === undefined ? rawBody : ""),
        json,
      };
      calls.push(call);
      const out = route(call);
      const isReply =
        out !== null &&
        typeof out === "object" &&
        !Array.isArray(out) &&
        Object.keys(out).length > 0 &&
        Object.keys(out).every((k) => k === "status" || k === "body");
      const reply: Reply = isReply ? (out as Reply) : { body: out };
      return {
        status: reply.status ?? 200,
        headers: {},
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
