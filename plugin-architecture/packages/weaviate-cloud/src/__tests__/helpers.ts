import type { HostServices } from "@infrawrench/plugin-base";

export interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

const RAW = Symbol("raw");

interface Raw {
  [RAW]: true;
  status: number;
  body: string;
}

/** An explicit response: a status plus a JSON body, or raw text. */
export function respond(status: number, body: unknown, text = false): Raw {
  return { [RAW]: true, status, body: text ? String(body) : JSON.stringify(body) };
}

type Handler = (call: Call) => unknown;

/** A fake `services.http` routed by `METHOD host+path`. Unrouted requests answer 404. */
export function fakeHttp() {
  const calls: Call[] = [];
  const routes = new Map<string, Handler>();
  const secrets = new Map<string, string>();
  const services: HostServices = {
    http: {
      async request(req) {
        const url = new URL(req.url);
        let body: unknown;
        if (typeof req.body === "string" && req.body) {
          try {
            body = JSON.parse(req.body) as unknown;
          } catch {
            body = req.body;
          }
        }
        const call: Call = { method: req.method, url, headers: req.headers, body };
        calls.push(call);
        const handler = routes.get(`${req.method} ${url.host}${url.pathname}`);
        if (!handler) {
          return {
            status: 404,
            headers: {},
            body: JSON.stringify({ status: 404, error: { code: "NOT_FOUND", message: "nope" } }),
          };
        }
        const out = handler(call);
        if (out && typeof out === "object" && RAW in out) {
          const r = out as Raw;
          return { status: r.status, headers: {}, body: r.body };
        }
        return { status: 200, headers: {}, body: out === undefined ? "" : JSON.stringify(out) };
      },
    },
    secrets: {
      async getPlaintext(resourceId, fieldKey) {
        return secrets.get(`${resourceId}/${fieldKey}`) ?? null;
      },
      async setPlaintext(resourceId, fieldKey, value) {
        secrets.set(`${resourceId}/${fieldKey}`, value);
      },
    },
  };
  return {
    calls,
    secrets,
    services,
    route(method: string, hostPath: string, handler: Handler | unknown) {
      routes.set(
        `${method} ${hostPath}`,
        typeof handler === "function" ? (handler as Handler) : () => handler,
      );
    },
  };
}
