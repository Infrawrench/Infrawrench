/**
 * The MCP server's addresses, at the three ends that must agree: the
 * contract's constants, the Worker's router, and (by the same patterns) the
 * development server's proxy list.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MCP_PATH,
  OAUTH_PATHS,
  WELL_KNOWN_PATHS,
  mcpUrl,
  namespaceSlugProblem,
} from "@infrawrench/git-contract";
import type { Env } from "../../env";
import { type Routes, routeOf, serve } from "../../http/router";

const env = {} as Env;
const ctx = { waitUntil: () => {} };
const base: Routes = {
  api: async () => Response.json({ ok: true }),
  auth: async () => new Response("auth"),
};
const request = (path: string, init?: RequestInit) =>
  new Request(`https://git.example.test${path}`, init);

describe("where the MCP server is", () => {
  it("routes the endpoint, the authorization server and discovery", () => {
    expect(mcpUrl()).toBe("https://git.infrawrench.com/mcp");
    expect(routeOf(MCP_PATH)).toEqual({ kind: "mcp" });
    expect(routeOf("/mcp/")).toEqual({ kind: "mcp" });
    expect(routeOf(OAUTH_PATHS.authorize)).toEqual({ kind: "oauth", action: "authorize" });
    expect(routeOf(OAUTH_PATHS.token)).toEqual({ kind: "oauth", action: "token" });
    expect(routeOf(OAUTH_PATHS.register)).toEqual({ kind: "oauth", action: "register" });
    expect(routeOf(OAUTH_PATHS.revoke)).toEqual({ kind: "oauth", action: "revoke" });
    expect(routeOf(WELL_KNOWN_PATHS.protectedResource)).toEqual({ kind: "well-known" });
    expect(routeOf(`${WELL_KNOWN_PATHS.protectedResource}${MCP_PATH}`)).toEqual({
      kind: "well-known",
    });
    expect(routeOf(WELL_KNOWN_PATHS.authorizationServer)).toEqual({ kind: "well-known" });
    expect(routeOf("/.well-known/openid-configuration")).toEqual({ kind: "well-known" });
  });

  it("takes nothing beside them, and no page of the UI", () => {
    expect(routeOf("/mcp/anything")).toEqual({ kind: "not-found" });
    expect(routeOf("/oauth")).toEqual({ kind: "not-found" });
    expect(routeOf("/oauth/authorize/extra")).toEqual({ kind: "not-found" });
    expect(routeOf("/oauth/anything-else")).toEqual({ kind: "not-found" });
    // A person or a repository whose name only starts the same way.
    expect(routeOf("/mcpherson")).toEqual({ kind: "assets" });
    expect(routeOf("/mcpherson/tools")).toEqual({ kind: "assets" });
    expect(routeOf("/oauthorize/x")).toEqual({ kind: "assets" });
    expect(routeOf("/acme/mcp")).toEqual({ kind: "assets" });
  });

  it("is never somebody's namespace", () => {
    for (const slug of ["mcp", "MCP", "oauth", ".well-known"]) {
      expect([slug, namespaceSlugProblem(slug)]).not.toEqual([slug, null]);
    }
    expect(namespaceSlugProblem("mcpherson")).toBeNull();
  });

  it("answers 503 or a plain 404 while a build does not serve them, never the UI's shell", async () => {
    const shell = {
      ASSETS: {
        fetch: async () =>
          new Response("<!doctype html>", { headers: { "content-type": "text/html" } }),
      },
    } as unknown as Env;
    for (const path of [MCP_PATH, OAUTH_PATHS.token]) {
      const response = await serve(request(path, { method: "POST" }), shell, ctx, base);
      expect([path, response.status]).toEqual([path, 503]);
    }
    const discovery = await serve(request(WELL_KNOWN_PATHS.protectedResource), shell, ctx, base);
    expect(discovery.status).toBe(404);
    expect(discovery.headers.get("content-type")).toContain("text/plain");
  });

  it("puts the Worker's headers on its answers, and leaves the consent page's policy alone", async () => {
    const policy = "default-src 'none'; form-action 'self' http://127.0.0.1:43110";
    const routes: Routes = {
      ...base,
      mcp: async () => Response.json({ jsonrpc: "2.0" }),
      oauth: async () =>
        new Response("<!doctype html>", {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": policy,
          },
        }),
    };
    const mcp = await serve(request(MCP_PATH, { method: "POST" }), env, ctx, routes);
    expect(mcp.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(mcp.headers.get("x-content-type-options")).toBe("nosniff");
    expect(mcp.headers.get("x-request-id")).toBeTruthy();
    const page = await serve(request(OAUTH_PATHS.authorize), env, ctx, routes);
    expect(page.headers.get("content-security-policy")).toBe(policy);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
  });

  it("is proxied to the Worker by the development server, by pattern", () => {
    const config = readFileSync(new URL("../../../../web/vite.config.ts", import.meta.url), "utf8");
    const patterns = [...config.matchAll(/^\s*"(\^[^"]+)": WORKER,/gm)].map(
      (match) => new RegExp(JSON.parse(`"${match[1]}"`) as string),
    );
    const proxied = (path: string) => patterns.some((pattern) => pattern.test(path));
    for (const path of [
      MCP_PATH,
      "/mcp/",
      "/mcp?x=1",
      ...Object.values(OAUTH_PATHS),
      `${OAUTH_PATHS.authorize}?client_id=x`,
      ...Object.values(WELL_KNOWN_PATHS),
      `${WELL_KNOWN_PATHS.protectedResource}${MCP_PATH}`,
    ]) {
      expect([path, proxied(path)]).toEqual([path, true]);
      expect([path, routeOf(path.split("?")[0]!).kind]).not.toEqual([path, "assets"]);
    }
    for (const path of ["/mcpherson", "/mcpherson/tools", "/acme/mcp", "/oauthorize"]) {
      expect([path, proxied(path)]).toEqual([path, false]);
    }
  });
});
