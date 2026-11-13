/**
 * A fake {@link HttpHostServices} for CI executor tests: routes requests by
 * method and URL to answers and records what was sent. It never touches the
 * network, so a test cannot reach a provider by mistake.
 */
import type { HttpHostServices } from "./manifest.js";

/** An answer with a status other than 200. */
export class FakeHttpReply {
  constructor(
    readonly status: number,
    readonly body: unknown = {},
    readonly headers: Record<string, string> = {},
  ) {}
}

/** A request the fake received. `body` is parsed as JSON when it can be. */
export interface FakeHttpCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A route is `"METHOD /path-prefix"` (matched against the URL's path and
 * query) and a function answering it: a value for a 200 with that JSON body,
 * `undefined` for a 204, or a {@link FakeHttpReply}. The first match wins;
 * a request no route matches throws, naming it.
 */
export function fakeCiHttp(
  routes: ReadonlyArray<readonly [string, (call: FakeHttpCall) => unknown]>,
): { http: HttpHostServices; sent: FakeHttpCall[] } {
  const sent: FakeHttpCall[] = [];
  const http: HttpHostServices = {
    async request(req) {
      const url = new URL(req.url);
      let body: unknown = req.body;
      if (typeof body === "string" && body) {
        try {
          body = JSON.parse(body);
        } catch {
          // Plain text stays text.
        }
      }
      const call: FakeHttpCall = { method: req.method, url, headers: req.headers, body };
      sent.push(call);
      const target = decodeURIComponent(`${url.pathname}${url.search}`);
      const match = routes.find(([pattern]) => {
        const space = pattern.indexOf(" ");
        const method = pattern.slice(0, space);
        const prefix = pattern.slice(space + 1);
        return method === req.method && target.includes(prefix);
      });
      if (!match) throw new Error(`fakeCiHttp: unexpected ${req.method} ${target}`);
      const answer = await match[1](call);
      if (answer instanceof FakeHttpReply) {
        return {
          status: answer.status,
          headers: { "content-type": "application/json", ...answer.headers },
          body: typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body),
        };
      }
      if (answer === undefined) return { status: 204, headers: {}, body: "" };
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: typeof answer === "string" ? answer : JSON.stringify(answer),
      };
    },
  };
  return { http, sent };
}
