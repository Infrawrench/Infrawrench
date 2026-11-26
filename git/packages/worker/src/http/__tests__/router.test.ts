import { describe, expect, it } from "vitest";
import type { Env } from "../../env";
import { mentionedNumbers } from "../../api/thread-edits";
import { closingNumbers } from "../../events/consumer";
import { type Routes, routeOf, serve } from "../router";

const env = {} as Env;
const ctx = { waitUntil: () => {} };
const routes: Routes = {
  api: async () => Response.json({ ok: true }),
  auth: async (_request, _env, _ctx, route) => new Response(route.action),
};

describe("routeOf", () => {
  it("keeps the API, sign-in and the Git paths in the Worker", () => {
    expect(routeOf("/api")).toEqual({ kind: "api" });
    expect(routeOf("/api/repos/acme/infra")).toEqual({ kind: "api" });
    expect(routeOf("/auth/sign-in")).toEqual({ kind: "auth", action: "sign-in" });
    expect(routeOf("/auth/callback")).toEqual({ kind: "auth", action: "callback" });
    expect(routeOf("/auth/sign-out")).toEqual({ kind: "auth", action: "sign-out" });
    expect(routeOf("/auth/t3/callback")).toEqual({ kind: "auth", action: "t3-callback" });
    expect(routeOf("/auth/anything-else")).toEqual({ kind: "not-found" });
    expect(routeOf("/acme/infra.git/info/refs")).toEqual({
      kind: "smart-http",
      owner: "acme",
      repo: "infra",
      rest: ["info", "refs"],
    });
    expect(routeOf("/acme/infra.GIT/git-upload-pack")).toMatchObject({ kind: "smart-http" });
    expect(routeOf("/acme/infra/raw/main/src/a.ts")).toEqual({
      kind: "raw",
      owner: "acme",
      repo: "infra",
      rest: ["main", "src", "a.ts"],
    });
    expect(routeOf("/acme/infra/archive/main.tar.gz")).toMatchObject({ kind: "archive" });
    expect(routeOf("/acme/infra/terraform/prod/state/lock")).toEqual({
      kind: "terraform-state",
      owner: "acme",
      repo: "infra",
      workspace: "prod",
      rest: ["lock"],
    });
  });

  it("routes the image proxy, and nothing else under /-/", () => {
    expect(routeOf("/-/image")).toEqual({ kind: "image-proxy" });
    expect(routeOf("/-/image/x")).toEqual({ kind: "not-found" });
    expect(routeOf("/-/anything")).toEqual({ kind: "not-found" });
  });

  it("leaves the UI's own pages to the UI", () => {
    for (const path of [
      "/",
      "/explore",
      "/acme",
      "/acme/infra",
      "/acme/infra/tree/main/src",
      "/acme/infra/pulls/3",
      // The Infrastructure tab, not the state backend.
      "/acme/infra/terraform",
      "/acme/infra/terraform/prod",
    ]) {
      expect(routeOf(path), path).toEqual({ kind: "assets" });
    }
  });
});

describe("serve", () => {
  const request = (path: string, init?: RequestInit) =>
    new Request(`https://git.example.test${path}`, init);

  it("puts the security headers and a request id on every answer", async () => {
    for (const path of ["/api/session", "/auth/sign-in", "/acme/infra.git/info/refs", "/nope"]) {
      const response = await serve(request(path), env, ctx, routes);
      expect(response.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(response.headers.get("x-frame-options"), path).toBe("DENY");
      expect(response.headers.get("referrer-policy"), path).toBe("strict-origin-when-cross-origin");
      expect(response.headers.get("content-security-policy"), path).toContain(
        "frame-ancestors 'none'",
      );
      expect(response.headers.get("strict-transport-security"), path).toContain("max-age=");
      expect(response.headers.get("cross-origin-opener-policy"), path).toBe("same-origin");
      expect(response.headers.get("x-request-id"), path).toMatch(/\S+/);
    }
  });

  it("uses Cloudflare's ray id as the request id when there is one", async () => {
    const response = await serve(
      request("/api/session", { headers: { "cf-ray": "8f0a-LHR" } }),
      env,
      ctx,
      routes,
    );
    expect(response.headers.get("x-request-id")).toBe("8f0a-LHR");
  });

  it("gives a page the page's policy and data the closed one", async () => {
    const page = await serve(request("/acme/infra"), { ...env, ASSETS: assets() }, ctx, routes);
    const policy = page.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("script-src 'self';");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    const data = await serve(request("/api/session"), env, ctx, routes);
    expect(data.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  });

  it("keeps a policy the route set itself", async () => {
    const sandboxed: Routes = {
      ...routes,
      raw: async () =>
        new Response("<script>", { headers: { "content-security-policy": "sandbox" } }),
    };
    const response = await serve(request("/acme/infra/raw/main/a.html"), env, ctx, sandboxed);
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
  });

  it("answers the Git and Terraform paths 503 until the storage serves them, never the UI", async () => {
    const withAssets = { ...env, ASSETS: assets() };
    for (const path of [
      "/acme/infra.git/info/refs?service=git-upload-pack",
      "/acme/infra/raw/main/README.md",
      "/acme/infra/archive/main.zip",
      "/acme/infra/terraform/prod/state",
    ]) {
      const response = await serve(request(path), withAssets, ctx, routes);
      expect(response.status, path).toBe(503);
      expect(response.headers.get("content-type"), path).toContain("text/plain");
    }
  });

  it("serves the UI for everything else, and only to GET and HEAD", async () => {
    const withAssets = { ...env, ASSETS: assets() };
    const page = await serve(request("/acme/infra/issues"), withAssets, ctx, routes);
    expect(await page.text()).toBe("<!doctype html>");
    expect(
      (await serve(request("/acme", { method: "POST" }), withAssets, ctx, routes)).status,
    ).toBe(405);
    expect((await serve(request("/acme"), env, ctx, routes)).status).toBe(404);
  });

  it("answers a route that throws with a 500 that says nothing", async () => {
    const broken: Routes = {
      ...routes,
      api: async () => {
        throw new Error("postgres://user:secret@host");
      },
    };
    const response = await serve(request("/api/session"), env, ctx, broken);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error\n");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});

/** The `assets` binding with `not_found_handling: "single-page-application"`: the shell for any path. */
function assets(): NonNullable<Env["ASSETS"]> {
  return {
    fetch: async () =>
      new Response("<!doctype html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
  } as unknown as NonNullable<Env["ASSETS"]>;
}

describe("what a commit message says about issues", () => {
  it("reads the closing keywords", () => {
    expect(closingNumbers("Fix the cache\n\nFixes #12, closes #3 and resolved: #7")).toEqual([
      12, 3, 7,
    ]);
    expect(closingNumbers("prefixes #12 are not fixes")).toEqual([]);
    expect(closingNumbers("See #4")).toEqual([]);
  });

  it("reads every mention, but not an anchor or an entity", () => {
    expect(mentionedNumbers("See #4 and (#5), not page#6, a/b#7 or &#8;")).toEqual([4, 5]);
  });
});
