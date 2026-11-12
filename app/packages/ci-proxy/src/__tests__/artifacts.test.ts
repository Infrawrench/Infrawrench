import { describe, expect, it } from "vitest";
import { handle, type Deps } from "../app";
import {
  disposition,
  MemorySweepState,
  parseRange,
  signDownload,
  SWEEP_EVERY_SECS,
  sweepDownloads,
  type ArtifactBody,
  type ArtifactBucket,
  type ArtifactObject,
  type ArtifactRange,
  type DownloadLink,
  type Downloads,
} from "../artifacts";
import { Pool } from "../pool";
import { MemoryRunnerList } from "../runners";
import { MemoryStore } from "../store";
import { MemoryValues } from "../values";

/** A fixed test key, not a real secret. */
const SIGNING_KEY = "download-test-key-not-a-real-secret";
const NOW = 1_800_000_000;
const OBJECT = `${NOW + 86_400}-${"ab".repeat(16)}`;
const KEY = `artifacts/github.com-acme/web/0123456789abcdef0123456789abcdef/${OBJECT}`;

/** An R2 bucket in memory: enough of the binding for downloads. */
class FakeBucket implements ArtifactBucket {
  objects = new Map<string, { data: Uint8Array; contentType: string }>();
  deleted: string[] = [];
  gets: Array<{ key: string; range: ArtifactRange | undefined }> = [];

  put(key: string, text: string, contentType = "text/plain; charset=utf-8"): void {
    this.objects.set(key, { data: new TextEncoder().encode(text), contentType });
  }

  private describe(key: string): ArtifactObject | null {
    const o = this.objects.get(key);
    if (!o) return null;
    return {
      key,
      size: o.data.length,
      httpEtag: `"${key.length}"`,
      httpMetadata: { contentType: o.contentType },
    };
  }

  async head(key: string): Promise<ArtifactObject | null> {
    return this.describe(key);
  }

  async get(key: string, options?: { range?: ArtifactRange }): Promise<ArtifactBody | null> {
    this.gets.push({ key, range: options?.range });
    const meta = this.describe(key);
    const o = this.objects.get(key);
    if (!meta || !o) return null;
    let bytes = o.data;
    const range = options?.range;
    if (range) {
      const start = "suffix" in range ? Math.max(0, bytes.length - range.suffix) : range.offset;
      if (start >= bytes.length) throw new Error("The requested range is not satisfiable");
      const end =
        "suffix" in range || range.length === undefined ? bytes.length : start + range.length;
      bytes = bytes.slice(start, end);
    }
    return {
      ...meta,
      ...(range ? { range } : {}),
      body: new Response(bytes).body as ReadableStream,
    };
  }

  async list(options: { prefix: string; cursor?: string; limit?: number }) {
    // Like R2's, the cursor stays good while keys are deleted: it is the
    // last key listed.
    const after = options.cursor ?? "";
    const keys = [...this.objects.keys()]
      .filter((k) => k.startsWith(options.prefix) && k > after)
      .sort();
    const page = keys.slice(0, options.limit ?? 1000);
    const truncated = page.length < keys.length;
    return {
      objects: page.map((key) => ({ key })),
      truncated,
      ...(truncated ? { cursor: page[page.length - 1] } : {}),
    };
  }

  async delete(keys: string[]): Promise<void> {
    for (const k of keys) {
      this.objects.delete(k);
      this.deleted.push(k);
    }
  }
}

function setup(key: string | null = SIGNING_KEY) {
  const bucket = new FakeBucket();
  bucket.put(KEY, "hello, download", "text/html; charset=utf-8");
  const downloads: Downloads = { bucket, key, sweep: new MemorySweepState() };
  const clock = { now: NOW };
  const deps: Deps = {
    pool: Pool.fromList("http://a.test", "runner-key", async () => new Response("{}")),
    runnerList: new MemoryRunnerList(),
    store: new MemoryStore(),
    values: new MemoryValues(),
    secretsKey: null,
    proxyKey: "proxy-test-key-not-a-real-secret",
    now: () => clock.now,
    downloads,
  };
  return { bucket, deps, clock, downloads };
}

const LINK: DownloadLink = {
  owner: "github.com-acme",
  repoId: "web",
  run: "0123456789abcdef0123456789abcdef",
  object: OBJECT,
  name: "report é.html",
  expires: NOW + 900,
};

async function url(link: DownloadLink = LINK, signWith: DownloadLink = link): Promise<string> {
  const s = await signDownload(SIGNING_KEY, signWith);
  const q = new URLSearchParams({ n: link.name, e: String(link.expires), s });
  return `https://proxy.example/v1/artifacts/${link.owner}/${link.repoId}/${link.run}/${link.object}?${q}`;
}

function get(deps: Deps, href: string, init: RequestInit = {}) {
  return handle(new Request(href, init), deps);
}

describe("downloads", () => {
  it("signs as server-core does (a vector both test suites check)", async () => {
    // The same fields and key as server-core's downloads.test.ts.
    expect(
      await signDownload("vector-key", {
        owner: "github.com-acme",
        repoId: "web",
        run: "0123456789abcdef0123456789abcdef",
        object: "1800086400-abababababababababababababababab",
        name: "report.html",
        expires: 1_800_000_900,
      }),
    ).toBe("PK6ELOhorwq8mbJJ-xC_6fqxDrl9CTa7m4V2HphcOzc");
  });

  it("serves a signed link as an attachment, without the proxy key", async () => {
    const { deps } = setup();
    const res = await get(deps, await url());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello, download");
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      "attachment; filename=\"report _.html\"; filename*=UTF-8''report%20%C3%A9.html",
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Length")).toBe("15");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
  });

  it("answers HEAD and byte ranges", async () => {
    const { deps } = setup();
    const head = await get(deps, await url(), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("15");
    expect(await head.text()).toBe("");

    const part = await get(deps, await url(), { headers: { Range: "bytes=7-14" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe("bytes 7-14/15");
    expect(await part.text()).toBe("download");

    const tail = await get(deps, await url(), { headers: { Range: "bytes=-3" } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("Content-Range")).toBe("bytes 12-14/15");
    expect(await tail.text()).toBe("oad");

    const open = await get(deps, await url(), { headers: { Range: "bytes=7-" } });
    expect(open.headers.get("Content-Range")).toBe("bytes 7-14/15");

    expect((await get(deps, await url(), { headers: { Range: "bytes=99-" } })).status).toBe(416);
    expect((await get(deps, await url(), { headers: { Range: "bytes=5-2" } })).status).toBe(416);
    // Several ranges are served whole.
    const many = await get(deps, await url(), { headers: { Range: "bytes=0-1,4-5" } });
    expect(many.status).toBe(200);
  });

  it("refuses an expired link, and a file past its own expiry", async () => {
    const { deps, clock } = setup();
    const href = await url();
    clock.now = LINK.expires;
    const res = await get(deps, href);
    expect(res.status).toBe(410);
    expect(((await res.json()) as { error: string }).error).toContain("expired");

    // A link still good, for a file whose retention has run out.
    clock.now = NOW;
    const old = { ...LINK, object: `${NOW - 1}-${"ab".repeat(16)}` };
    expect((await get(deps, await url(old))).status).toBe(410);
    // A link signed for longer than a day is not one the app makes.
    expect((await get(deps, await url({ ...LINK, expires: NOW + 2 * 86_400 }))).status).toBe(403);
  });

  it("refuses a tampered link", async () => {
    const { deps, bucket } = setup();
    const good = await url();
    // Another name, a later expiry, another signature, or none.
    expect((await get(deps, good.replace("n=report", "n=evil"))).status).toBe(403);
    expect(
      (await get(deps, good.replace(`e=${LINK.expires}`, `e=${LINK.expires + 60}`))).status,
    ).toBe(403);
    expect((await get(deps, good.replace(/s=[^&]+/, "s=AAAA"))).status).toBe(403);
    expect((await get(deps, good.replace(/&s=[^&]+/, ""))).status).toBe(403);
    // A key other than the proxy's.
    const forged = new URL(good);
    forged.searchParams.set("s", await signDownload("another-key", LINK));
    expect((await get(deps, forged.toString())).status).toBe(403);
    expect(bucket.gets).toHaveLength(0);
  });

  it("refuses a link for one repository used on another's file", async () => {
    const { deps, bucket } = setup();
    // The other repository's file is there; the signature is for `web`'s.
    bucket.put(`artifacts/github.com-acme/api/${LINK.run}/${OBJECT}`, "api's secret build");
    const signed = await url();
    const moved = signed.replace("/github.com-acme/web/", "/github.com-acme/api/");
    expect((await get(deps, moved)).status).toBe(403);
    const otherOwner = signed.replace("/github.com-acme/", "/github.com-evil/");
    expect((await get(deps, otherOwner)).status).toBe(403);
    const otherRun = signed.replace(LINK.run, "f".repeat(32));
    expect((await get(deps, otherRun)).status).toBe(403);
    expect(bucket.gets).toHaveLength(0);
    // Signed for the right repository, the file is served.
    const api = { ...LINK, repoId: "api" };
    expect(await (await get(deps, await url(api))).text()).toBe("api's secret build");
  });

  it("refuses malformed links and works only when configured", async () => {
    const { deps } = setup();
    const bad = await url({ ...LINK, owner: "bad!owner" });
    expect((await get(deps, bad)).status).toBe(400);
    expect((await get(deps, `${await url()}`.replace("?", "/extra?"))).status).toBe(400);
    expect((await get(deps, await url({ ...LINK, name: "a/b" }))).status).toBe(400);
    expect((await get(deps, await url(), { method: "POST" })).status).toBe(405);
    // Nothing there, though signed.
    const missing = { ...LINK, object: `${NOW + 86_400}-${"cd".repeat(16)}` };
    expect((await get(deps, await url(missing))).status).toBe(404);

    const unkeyed = setup(null);
    expect((await get(unkeyed.deps, await url())).status).toBe(503);
    const unbound = setup();
    delete unbound.deps.downloads;
    expect((await get(unbound.deps, await url())).status).toBe(503);
  });

  it("sweeps expired downloads a few pages a tick, then rests", async () => {
    const { bucket, downloads } = setup();
    bucket.objects.clear();
    const live = `${NOW + 60}-${"ab".repeat(16)}`;
    const dead = `${NOW - 60}-${"ab".repeat(16)}`;
    for (let i = 0; i < 2500; i++) {
      bucket.put(`artifacts/o/r/run${String(i).padStart(4, "0")}/${i % 2 ? live : dead}`, "x");
    }
    bucket.put("artifacts/o/r/run/not-a-download", "x");
    bucket.put("caches/o/r/b-1/entries/x.zst", "x");

    let swept = await sweepDownloads(downloads, NOW);
    expect(swept.scanned).toBe(2501);
    expect(swept.deleted).toBe(1250);
    expect(swept.cursor).toBeNull();
    expect(bucket.objects.has("caches/o/r/b-1/entries/x.zst")).toBe(true);
    expect(bucket.objects.has("artifacts/o/r/run/not-a-download")).toBe(true);
    expect(bucket.deleted.every((k) => k.endsWith(dead))).toBe(true);

    // Rests for an hour after reaching the end.
    swept = await sweepDownloads(downloads, NOW + 60);
    expect(swept.skipped).toBe(true);

    // More than three pages: the next tick goes on from the cursor.
    for (let i = 0; i < 3500; i++)
      bucket.put(`artifacts/p/r/x${String(i).padStart(4, "0")}/${live}`, "x");
    swept = await sweepDownloads(downloads, NOW + SWEEP_EVERY_SECS + 61);
    expect(swept.scanned).toBe(3000);
    expect(swept.cursor).not.toBeNull();
    swept = await sweepDownloads(downloads, NOW + SWEEP_EVERY_SECS + 120);
    expect(swept.cursor).toBeNull();
    expect(swept.deleted).toBeGreaterThan(0);
  });

  it("writes the file name for Content-Disposition safely", () => {
    expect(disposition('a"b\\c.txt')).toBe(
      "attachment; filename=\"a_b_c.txt\"; filename*=UTF-8''a%22b%5Cc.txt",
    );
    expect(parseRange("bytes=0-0")).toEqual({ offset: 0, length: 1 });
    expect(parseRange("bytes=-")).toBe("invalid");
    expect(parseRange("items=0-1")).toBeNull();
  });
});
