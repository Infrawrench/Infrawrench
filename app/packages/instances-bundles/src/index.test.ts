import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_CACHE_SECONDS,
  DEFAULT_EDGE_CACHE_CONTROL,
  authenticate,
  objectKey,
  readObject,
} from "./bundles.js";
import worker, { type Env } from "./index.js";

/**
 * The gateway is the only thing between the bucket and the internet, so most of
 * these are about what it refuses and what it strips before the cached read.
 */

interface StoredObject {
  body: string;
  contentType?: string;
  cacheControl?: string;
  etag?: string;
}

/** Just enough of `R2Bucket` for `readObject`: get (with onlyIf/range) and head. */
function fakeBucket(objects: Record<string, StoredObject>): R2Bucket {
  const uploaded = new Date("2026-10-01T12:00:00Z");

  function meta(key: string, stored: StoredObject) {
    const etag = stored.etag ?? `etag-${key}`;
    return {
      key,
      size: stored.body.length,
      etag,
      httpEtag: `"${etag}"`,
      uploaded,
      httpMetadata: {
        contentType: stored.contentType,
        cacheControl: stored.cacheControl,
      },
      writeHttpMetadata(headers: Headers) {
        if (stored.contentType) headers.set("content-type", stored.contentType);
        if (stored.cacheControl) headers.set("cache-control", stored.cacheControl);
      },
    };
  }

  return {
    async head(key: string) {
      const stored = objects[key];
      return stored ? meta(key, stored) : null;
    },
    async get(key: string, options?: { onlyIf?: Headers; range?: Headers }) {
      const stored = objects[key];
      if (!stored) return null;
      const object = meta(key, stored);
      const ifNoneMatch = options?.onlyIf?.get("if-none-match");
      const ifMatch = options?.onlyIf?.get("if-match");
      if (ifNoneMatch === object.httpEtag || (ifMatch && ifMatch !== object.httpEtag)) {
        return object;
      }
      const rangeHeader = options?.range?.get("range");
      const match = rangeHeader?.match(/^bytes=(\d+)-(\d+)$/);
      if (match) {
        const offset = Number(match[1]);
        const length = Number(match[2]) - offset + 1;
        return {
          ...object,
          range: { offset, length },
          body: new Response(stored.body.slice(offset, offset + length)).body,
        };
      }
      return { ...object, body: new Response(stored.body).body };
    },
  } as unknown as R2Bucket;
}

/** An in-memory Cache API that honours nothing but presence. */
function fakeCache(): Cache & { store: Map<string, Response> } {
  const store = new Map<string, Response>();
  return {
    store,
    async match(request: RequestInfo | URL) {
      return store.get(new Request(request).url);
    },
    async put(request: RequestInfo | URL, response: Response) {
      store.set(new Request(request).url, response);
    },
    async delete() {
      return false;
    },
  } as unknown as Cache & { store: Map<string, Response> };
}

/** The web Worker's `/api/v1/whoami`, answering from a fixed set of live tokens. */
function fakeApi(live: string[], behaviour: "ok" | "down" | "throws" = "ok") {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (behaviour === "throws") throw new Error("connection reset");
    if (behaviour === "down") return new Response("Bad gateway", { status: 502 });
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.pathname).toBe("/api/v1/whoami");
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const token = auth.replace(/^Bearer /, "");
    if (!live.includes(token)) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return Response.json({ userId: "user_1", organizationId: "org-1", principal: "api_key" });
  });
  return { fetch } as unknown as Fetcher & { fetch: typeof fetch };
}

let cache: ReturnType<typeof fakeCache>;

beforeEach(() => {
  cache = fakeCache();
  (globalThis as unknown as { caches: { default: Cache } }).caches = { default: cache };
});

/**
 * Run the gateway with a `Bundles` loopback that reads the fake bucket, the way
 * `ctx.exports` would (minus Workers Caching, which only exists deployed).
 */
function gateway(objects: Record<string, StoredObject>, api = fakeApi(["iwk_live"])) {
  const bucket = fakeBucket(objects);
  const forwarded: Request[] = [];
  const env: Env = { BUNDLES: bucket, API: api };
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void p,
    passThroughOnException() {},
    props: {},
    exports: {
      Bundles: {
        fetch: async (request: Request) => {
          forwarded.push(request);
          return readObject(bucket, request);
        },
      },
    },
  } as unknown as ExecutionContext;
  const call = (path: string, init: RequestInit = {}) =>
    worker.fetch(
      new Request(`https://instances-bundles.infrawrench.com${path}`, init) as Parameters<
        typeof worker.fetch
      >[0],
      env,
      ctx,
    );
  return { call, forwarded, api };
}

const AUTH = { authorization: "Bearer iwk_live" };

describe("gateway", () => {
  it("refuses methods other than GET and HEAD", async () => {
    const { call } = gateway({});
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await call("/a.tar.gz", { method, headers: AUTH });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
    }
  });

  it("asks for a bearer token when none is sent", async () => {
    const { call, api } = gateway({ "a.tar.gz": { body: "x" } });
    const res = await call("/a.tar.gz");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("refuses a credential the API does not recognise, without reading R2", async () => {
    const { call, forwarded } = gateway({ "a.tar.gz": { body: "x" } });
    const res = await call("/a.tar.gz", { headers: { authorization: "Bearer iwk_revoked" } });
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it.each(["down", "throws"] as const)(
    "answers 503, not 401, when the API is %s",
    async (behaviour) => {
      const { call, forwarded } = gateway({ "a.tar.gz": { body: "x" } }, fakeApi([], behaviour));
      const res = await call("/a.tar.gz", { headers: AUTH });
      expect(res.status).toBe(503);
      expect(forwarded).toHaveLength(0);
    },
  );

  it("serves the object and strips the credential, cookies and query before the cached read", async () => {
    const { call, forwarded } = gateway({
      "v1/agent.tar.gz": { body: "bundle-bytes", contentType: "application/gzip" },
    });
    const res = await call("/v1/agent.tar.gz?cachebust=1", {
      headers: { ...AUTH, cookie: "wos-session=abc", "if-none-match": '"stale"' },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("bundle-bytes");
    expect(res.headers.get("content-type")).toBe("application/gzip");

    expect(forwarded).toHaveLength(1);
    const inner = forwarded[0]!;
    expect(inner.headers.has("authorization")).toBe(false);
    expect(inner.headers.has("cookie")).toBe(false);
    expect(new URL(inner.url).search).toBe("");
    // Conditional headers survive: they are how a client gets a cheap 304.
    expect(inner.headers.get("if-none-match")).toBe('"stale"');
  });

  it("tells the client not to share the response, whatever the edge cached it as", async () => {
    const { call } = gateway({
      "a.tar.gz": { body: "x", cacheControl: "public, max-age=31536000, immutable" },
    });
    const res = await call("/a.tar.gz", { headers: AUTH });
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("404s the bucket root without asking the API", async () => {
    const { call, api } = gateway({});
    const res = await call("/", { headers: AUTH });
    expect(res.status).toBe(404);
    expect(api.fetch).not.toHaveBeenCalled();
  });
});

describe("authenticate", () => {
  const ctx = { waitUntil: (p: Promise<unknown>) => void p };

  it("remembers a yes, so the next request skips the API", async () => {
    const api = fakeApi(["iwk_live"]);
    expect(await authenticate("iwk_live", { API: api }, ctx, cache)).toBe("allowed");
    expect(await authenticate("iwk_live", { API: api }, ctx, cache)).toBe("allowed");
    expect(api.fetch).toHaveBeenCalledTimes(1);

    const [key, stored] = [...cache.store.entries()][0]!;
    // Keyed by a hash: the credential itself is never a cache key.
    expect(key).not.toContain("iwk_live");
    expect(stored.headers.get("cache-control")).toBe(`max-age=${AUTH_CACHE_SECONDS}`);
  });

  it("never remembers a no, so a key minted a moment ago works at once", async () => {
    const api = fakeApi([]);
    expect(await authenticate("iwk_new", { API: api }, ctx, cache)).toBe("denied");
    expect(cache.store.size).toBe(0);
  });
});

describe("readObject", () => {
  const bucket = fakeBucket({
    "a.tar.gz": { body: "0123456789", contentType: "application/gzip", etag: "abc" },
    "pinned.tar.gz": { body: "x", cacheControl: "public, max-age=31536000, immutable" },
    "no-type": { body: "x" },
  });
  const read = (path: string, init: RequestInit = {}) =>
    readObject(bucket, new Request(`https://bundles.internal${path}`, init));

  it("returns the full object with validators and the default edge lifetime", async () => {
    const res = await read("/a.tar.gz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0123456789");
    expect(res.headers.get("etag")).toBe('"abc"');
    expect(res.headers.get("last-modified")).toBe("Thu, 01 Oct 2026 12:00:00 GMT");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("cache-control")).toBe(DEFAULT_EDGE_CACHE_CONTROL);
  });

  it("keeps an uploader's own Cache-Control", async () => {
    const res = await read("/pinned.tar.gz");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("invents no Content-Type, which would trip Cache Deception Armor", async () => {
    const res = await read("/no-type");
    expect(res.headers.has("content-type")).toBe(false);
  });

  it("answers HEAD from metadata alone", async () => {
    const res = await read("/a.tar.gz", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get("etag")).toBe('"abc"');
  });

  it("caches a miss briefly", async () => {
    const res = await read("/missing.tar.gz");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("public, max-age=30");
    expect((await read("/missing", { method: "HEAD" })).status).toBe(404);
  });

  it("answers 304 to a matching If-None-Match", async () => {
    const res = await read("/a.tar.gz", { headers: { "if-none-match": '"abc"' } });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"abc"');
  });

  it("answers 412 to a failed If-Match", async () => {
    const res = await read("/a.tar.gz", { headers: { "if-match": '"other"' } });
    expect(res.status).toBe(412);
  });

  it("serves a byte range when the cache has not taken the Range header", async () => {
    const res = await read("/a.tar.gz", { headers: { range: "bytes=2-5" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await res.text()).toBe("2345");
  });
});

describe("objectKey", () => {
  it.each([
    ["/a.tar.gz", "a.tar.gz"],
    ["/nested/path/a.tar.gz", "nested/path/a.tar.gz"],
    ["/with%20space.tar.gz", "with space.tar.gz"],
    ["/", ""],
    ["/bad%E0%A4%A", ""],
  ])("maps %s to %j", (path, key) => {
    expect(objectKey(new URL(`https://x${path}`))).toBe(key);
  });
});
