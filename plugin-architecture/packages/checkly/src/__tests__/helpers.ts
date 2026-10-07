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

/** Fake host HTTP service: `jsonRestFetch` prefers it, so requests run offline end to end. */
export function makeHttp(
  route: (url: URL, method: string, body: unknown, headers: Record<string, string>) => Reply,
) {
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
      const reply = route(url, req.method, body, req.headers);
      const text = reply.body === undefined ? "" : JSON.stringify(reply.body);
      return { status: reply.status ?? 200, headers: {}, body: text };
    },
  };
  return { http, calls };
}

export function memorySecrets(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async getPlaintext(resourceId: string, field: string) {
      return store.get(`${resourceId}#${field}`) ?? null;
    },
    async setPlaintext(resourceId: string, field: string, value: string) {
      store.set(`${resourceId}#${field}`, value);
    },
  };
}
