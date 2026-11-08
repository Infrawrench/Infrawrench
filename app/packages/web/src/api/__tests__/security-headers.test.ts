import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Effect, Schema } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { makeDomain, withApiDefaults } from "@/http/domain";
import { makeHttpApiHandler } from "@/http/server";
import { testMiddleware } from "@/http/testing";

/**
 * The header set and its adapters.
 *
 * The property that matters is that every adapter emits the *same* set: the
 * API router's global middleware covers every response `api` sends,
 * `setSecurityHeaders` the SPA and static files `server.ts` serves itself in
 * production, `applySecurityHeaders` `/api/mcp` and `/healthz`, which
 * `server.ts` answers at the Node HTTP level ahead of the API. Lists that
 * drift is exactly the failure this module's shape exists to prevent, so it
 * is asserted rather than assumed.
 */

const {
  applySecurityHeaders,
  securityHeaderEntries,
  resetSecurityHeadersCache,
  setSecurityHeaders,
} = await import("@/api/security-headers");

const Group = HttpApiGroup.make("headers").add(
  HttpApiEndpoint.get("hi", "/hi", { success: Schema.String }),
  HttpApiEndpoint.get("boom", "/boom", { success: Schema.String }),
);
class HeadersApi extends withApiDefaults(HttpApi.make("headers").add(Group)) {}
const handler = makeHttpApiHandler(
  [
    makeDomain(
      "headers",
      HeadersApi,
      HttpApiBuilder.group(HeadersApi, "headers", (h) =>
        h
          .handle("hi", () => Effect.succeed("hi"))
          .handle("boom", () => Effect.die(new Error("boom"))),
      ),
    ),
  ],
  testMiddleware(),
);
const request = (path: string) => handler.handle(new Request(`http://localhost${path}`));

/** Minimal stand-in for a `node:http` ServerResponse. */
function makeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
  };
}

const ORIGINAL_ENV = process.env["NODE_ENV"];

beforeEach(() => {
  resetSecurityHeadersCache();
});

afterEach(() => {
  process.env["NODE_ENV"] = ORIGINAL_ENV;
  resetSecurityHeadersCache();
});

describe("security headers", () => {
  it("sends the framing, sniffing and referrer defences", async () => {
    const res = await request("/hi");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("applies to error responses too", async () => {
    // A 500 that skips the headers is a 500 that can be framed.
    const res = await request("/boom");
    expect(res.status).toBe(500);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("applies to the 404 for a path nothing routes", async () => {
    const res = await request("/nowhere");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("gives every adapter the same set as the router", async () => {
    const viaRouter = await request("/hi");

    const res = makeRes();
    applySecurityHeaders(res as never);
    const web = new Headers();
    setSecurityHeaders(web);

    for (const [name, value] of securityHeaderEntries()) {
      expect(res.headers[name], `${name} via applySecurityHeaders`).toBe(value);
      expect(web.get(name), `${name} via setSecurityHeaders`).toBe(value);
      expect(viaRouter.headers.get(name), `${name} via the router`).toBe(value);
    }
  });

  it("withholds HSTS outside production", () => {
    process.env["NODE_ENV"] = "development";
    resetSecurityHeadersCache();
    const res = makeRes();
    applySecurityHeaders(res as never);
    // Pinning `localhost` to HTTPS for two years would follow a developer
    // across every project on the machine.
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });

  it("sends HSTS in production", () => {
    process.env["NODE_ENV"] = "production";
    resetSecurityHeadersCache();
    const res = makeRes();
    applySecurityHeaders(res as never);
    expect(res.headers["strict-transport-security"]).toContain("max-age=63072000");
    expect(res.headers["strict-transport-security"]).toContain("includeSubDomains");
  });

  it("restricts images to known hosts, so a rendered image cannot carry data anywhere", () => {
    const csp = new Map(securityHeaderEntries()).get("content-security-policy") ?? "";
    const imgSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("img-src "));
    expect(imgSrc).toBeDefined();
    const sources = imgSrc!.split(/\s+/).slice(1);
    expect(sources).toEqual(expect.arrayContaining(["'self'", "data:", "blob:"]));
    // No scheme-wide or wildcard source: either would admit any host.
    expect(sources).not.toContain("*");
    expect(sources).not.toContain("https:");
    expect(sources).not.toContain("http:");
  });

  it("does not ship a script-src that would be theatre", () => {
    // Guards the deliberate omission documented in the module: a CSP carrying
    // `unsafe-inline`/`unsafe-eval` reads as protection while permitting the
    // injection it exists to stop. If someone adds a real nonce-based
    // `script-src`, this assertion is the place to revisit.
    process.env["NODE_ENV"] = "production";
    resetSecurityHeadersCache();
    const csp = new Map(securityHeaderEntries()).get("content-security-policy") ?? "";
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });
});
