/**
 * The built SPA as `server.ts` serves it in production: files, the hashed
 * asset 404, the SPA fallback, and the headers `serveStatic` sent.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeStaticClientHandler } from "../static-client";

let root = "";
let serve: (request: Request) => Promise<Response>;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "iw-static-client-"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>shell</title>");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "app-abc123.js"), "console.log('app');");
  writeFileSync(join(root, "favicon.png"), "png-bytes");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "index.html"), "docs index");
  serve = makeStaticClientHandler(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const get = (path: string, init?: RequestInit) =>
  serve(new Request(`http://localhost${path}`, init));

describe("the static client", () => {
  it("serves a file with its type, length and modification time", async () => {
    const res = await get("/assets/app-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("content-length")).toBe("19");
    expect(res.headers.get("last-modified")).toBe(
      statSync(join(root, "assets", "app-abc123.js")).mtime.toUTCString(),
    );
    expect(res.headers.get("etag")).toBeNull();
    expect(await res.text()).toBe("console.log('app');");
  });

  it("carries the security headers on files, the shell and the 404", async () => {
    for (const path of ["/favicon.png", "/org/x/dashboards", "/assets/missing.js"]) {
      const res = await get(path);
      expect(res.headers.get("x-frame-options"), path).toBe("DENY");
      expect(res.headers.get("content-security-policy"), path).toContain("frame-ancestors 'none'");
    }
  });

  it("caches hashed assets for a year and leaves everything else to revalidate", async () => {
    const asset = await get("/assets/app-abc123.js");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    for (const path of ["/favicon.png", "/", "/org/abc/settings"]) {
      expect((await get(path)).headers.get("cache-control"), path).toBeNull();
    }
  });

  it("never serves the edge's _headers file", async () => {
    writeFileSync(join(root, "_headers"), "/*\n  x-test: 1\n");
    const res = await get("/_headers");
    expect(await res.text()).toBe("<!doctype html><title>shell</title>");
  });

  it("answers a directory with its index.html", async () => {
    const res = await get("/docs");
    expect(await res.text()).toBe("docs index");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("answers a missing hashed asset 404 no-store, never the shell", async () => {
    const res = await get("/assets/app-new999.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
    expect(await res.text()).toBe("Not found");
  });

  it("falls back to the SPA shell for any other path", async () => {
    const res = await get("/org/abc/settings/members");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("<!doctype html><title>shell</title>");
  });

  it("never serves a path that climbs out of the root", async () => {
    const res = await get("/assets/..%2f..%2f..%2fetc/passwd");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });

  it("answers HEAD and OPTIONS with the headers and no body", async () => {
    for (const method of ["HEAD", "OPTIONS"]) {
      const res = await get("/favicon.png", { method });
      expect(res.status, method).toBe(200);
      expect(res.headers.get("content-length"), method).toBe("9");
      expect(res.headers.get("content-type"), method).toBe("image/png");
      expect(await res.text(), method).toBe("");
    }
  });

  it("serves a single byte range, and refuses one past the end", async () => {
    const partial = await get("/favicon.png", { headers: { range: "bytes=0-2" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 0-2/9");
    expect(partial.headers.get("content-length")).toBe("3");
    expect(partial.headers.get("accept-ranges")).toBe("bytes");
    expect(await partial.text()).toBe("png");

    const suffix = await get("/favicon.png", { headers: { range: "bytes=-5" } });
    expect(await suffix.text()).toBe("bytes");

    const past = await get("/favicon.png", { headers: { range: "bytes=50-60" } });
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe("bytes */9");
  });
});
