import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

/**
 * The header set and its two adapters.
 *
 * The property that matters is that both adapters emit the *same* set: the
 * Hono middleware covers responses that go through Hono, `applySecurityHeaders`
 * covers `/api/mcp` and `/healthz`, which `server.ts` answers at the Node HTTP
 * level ahead of the Hono listener. Two lists that drift is exactly the failure
 * this module's shape exists to prevent, so it is asserted rather than assumed.
 */

const { securityHeaders, applySecurityHeaders, securityHeaderEntries, resetSecurityHeadersCache } =
  await import("@/api/security-headers");

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
    const app = new Hono();
    app.use("*", securityHeaders());
    app.get("/", (c) => c.text("hi"));

    const res = await app.request("/");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("applies to error responses too", async () => {
    // A 500 that skips the headers is a 500 that can be framed.
    const app = new Hono();
    app.use("*", securityHeaders());
    app.get("/", () => {
      throw new Error("boom");
    });
    app.onError((_e, c) => c.json({ error: "Internal server error" }, 500));

    const res = await app.request("/");
    expect(res.status).toBe(500);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("gives the raw-response adapter the same set as the middleware", async () => {
    const app = new Hono();
    app.use("*", securityHeaders());
    app.get("/", (c) => c.text("hi"));
    const viaHono = await app.request("/");

    const res = makeRes();
    applySecurityHeaders(res as never);

    for (const [name, value] of securityHeaderEntries()) {
      expect(res.headers[name], `${name} via applySecurityHeaders`).toBe(value);
      expect(viaHono.headers.get(name), `${name} via middleware`).toBe(value);
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
