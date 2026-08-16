import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { gunzipSync } from "node:zlib";

/**
 * The web server has no build-time copy of the Linux app server binaries — the
 * image is built from a pruned workspace that does not contain
 * `linux-appserver/` — so it reads them off the asset downloader at runtime and
 * caches them. What the cache does when the network misbehaves is the whole
 * point of the module: an enrolment that fails because the downloader had a bad
 * minute is a worse outcome than one that ships the previous build.
 */

const ORIGIN = "https://iwappd-hash-asset-downloader.infrawrench.com";
const TTL_MS = 10 * 60 * 1000;

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** `tar -cJf` over two stub binaries named the way the real archive names them. */
const ARCHIVE_BOTH = Buffer.from(
  "/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4CX/AdddABcXwcAN4XBkd8ji0xzZjqGzadoY40D8VACrmZfaGfhzO2tz54QfAJFNWa3XJ3MaAd7MC+4YFvqee+Cm+0ejH42RlIFZF7TVJekLVOjHdHOb4KotMFei1FI0FbzRELaqDwuadytXY4RD7ZlWYpKXoaeoHziB5xuUSs/aKmWXOXbj5X8r+boT4auYJ5xHQVA4SPtItgan80B2xohbv/IfpeIpPIBv+iwaT0lBkMn72uB0RGXnKJnWrL855wOUdUt3uDHKtlPs3sUsOmH/5xl3tujd/XYt4fIhoY2w5oU6UZTa2U8DMXcYchTU1cXMW+vuMm+4385Keq0d5iYU4RDUXmbJpK4oh3iT/yiYMS4jv1r+MbhjqsaHS0TqAKsKk8tHfMy1DQp4LuvW7m4oBUKbn1+s0S02xYZ3K1cMa4BvKzbddfG1eMPpUdkW2dPboUFXMcphCo8yQRSANR6lMMDxE3NTgrlVDYHSyU0dT2h5vELPHeDquDQ7HyEA4fVvIzXHxUCDxe4tzo5sgvZUfALy1chsbHsllYPvZAG8HFgRpICX9lbPxIjMdOnuKd07vkK4P0jP6UoVDl0jZAYDXEpVvVlE66vMyPtYANCOVB+g7Iu9iG2pdzv6AAAAP6eUmtEIyXMAAfMDgEwAACUHKoOxxGf7AgAAAAAEWVo=",
  "base64",
);
/** The same archive with the arm64 member left out — a botched publish. */
const ARCHIVE_ONLY_X86 = Buffer.from(
  "/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4Bn/AZ5dABcXwcAN4XBkd8ji0xzZjqGzadoY40D8VACrmZfaGfhzO2tz54QfAJFNWa3XJ3MaAd7MC+4YFvqee+Cm+0ejH42RlIFZF7TVJekLVOjHdHOb4KotMFei1FI0FbzRELaqDwuadytXY4RD7ZlWYpKXoaeoHziB5xuUSs/aKmWXOXbj5X8r+boT4auYJ5xHQVA4SPtItgan80B2xohbv/IfpeIpPIBv+iwaT0lBkMn72uB0RGXnKJnWrL855wOUdUt3uDHKtlPs3sUsOmH/5xl3tujd/XYyB/J5bcBsEEKYFAHaromqfaZhl+643eD5KIiqAIbxeHyNMa2GUeDtazd1VzxX3Vu3ZQYXVMoiGd3ZWCnpURn6sbPFDEzUAODeYEVa+ceqRWruXF4zY/hp/0Cg/pYaD9HiTA7v10OqAR8Gc4l0QmJuJuyBXpCRvVPa4TjDcLMdcd6Gqok7ckWf397Hm67QEDLl4baFWerGklhZ2K2UPWCihzFp2R4cJLWGBfROOt7anBCl5/Pl55gEawu9sBG9kLtCpgAbhsRYZoNhAAAAAMrdmMsqaN6lAAG6A4A0AABpZZ/xscRn+wIAAAAABFla",
  "base64",
);

const X86_PAYLOAD = "\x7fELF-fake-x86_64-payload";
const ARM_PAYLOAD = "\x7fELF-fake-aarch64-payload";

interface Downloader {
  /** What `GET /latest` answers with, or a thrown/failed response. */
  pointer: () => Response | Promise<Response>;
  archives: Record<string, Buffer>;
  latestCalls: number;
  archiveCalls: string[];
}

let downloader: Downloader;

function ok(body: Buffer | string): Response {
  // Buffer is a Uint8Array, which Response accepts; the cast keeps the
  // narrower BodyInit overloads happy.
  return new Response(body as unknown as BodyInit, { status: 200 });
}

/**
 * Fresh module state per test. The cache lives in module scope on purpose —
 * one set of binaries per instance, not per caller — so resetting the registry
 * is the only way to get a cold start.
 */
async function loadModule() {
  vi.resetModules();
  return import("../iwappd-binaries");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-16T12:00:00Z"));

  downloader = {
    pointer: () => ok(HASH_A),
    archives: { [HASH_A]: ARCHIVE_BOTH, [HASH_B]: ARCHIVE_ONLY_X86 },
    latestCalls: 0,
    archiveCalls: [],
  };

  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${ORIGIN}/latest`) {
      downloader.latestCalls++;
      return downloader.pointer();
    }
    const hash = url.slice(`${ORIGIN}/`.length);
    downloader.archiveCalls.push(hash);
    const archive = downloader.archives[hash];
    return archive ? ok(archive) : new Response("Not found", { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("getx86_64GzBinary / getArm64GzBinary", () => {
  it("serves each architecture's binary gzipped", async () => {
    const { getx86_64GzBinary, getArm64GzBinary } = await loadModule();

    expect(gunzipSync(await getx86_64GzBinary()).toString("latin1")).toBe(X86_PAYLOAD);
    expect(gunzipSync(await getArm64GzBinary()).toString("latin1")).toBe(ARM_PAYLOAD);
  });

  it("collapses concurrent cold callers into one download", async () => {
    // Every host enrolling at once on a fresh pod would otherwise each pull and
    // re-compress the same few megabytes.
    const { getx86_64GzBinary, getArm64GzBinary } = await loadModule();

    await Promise.all([getx86_64GzBinary(), getArm64GzBinary(), getx86_64GzBinary()]);

    expect(downloader.latestCalls).toBe(1);
    expect(downloader.archiveCalls).toEqual([HASH_A]);
  });

  it("does not touch the network again inside the TTL", async () => {
    const { getx86_64GzBinary } = await loadModule();
    await getx86_64GzBinary();

    vi.advanceTimersByTime(TTL_MS - 1);
    await getx86_64GzBinary();

    expect(downloader.latestCalls).toBe(1);
    expect(downloader.archiveCalls).toEqual([HASH_A]);
  });

  it("re-reads the pointer after the TTL but skips the download when the hash is unchanged", async () => {
    // This is the reason the pointer exists at all: a build that has not moved
    // should cost one small request, not the whole archive.
    const { getx86_64GzBinary } = await loadModule();
    const first = await getx86_64GzBinary();

    vi.advanceTimersByTime(TTL_MS);
    const second = await getx86_64GzBinary();

    expect(downloader.latestCalls).toBe(2);
    expect(downloader.archiveCalls).toEqual([HASH_A]);
    expect(second).toBe(first);
  });

  it("picks up a new build when the pointer moves", async () => {
    const { getx86_64GzBinary, getArm64GzBinary } = await loadModule();
    await getArm64GzBinary();

    downloader.archives[HASH_B] = ARCHIVE_BOTH;
    downloader.pointer = () => ok(HASH_B);
    vi.advanceTimersByTime(TTL_MS);
    await getx86_64GzBinary();

    expect(downloader.archiveCalls).toEqual([HASH_A, HASH_B]);
  });

  it("serves the cached build when a refresh fails", async () => {
    const { getx86_64GzBinary } = await loadModule();
    const fresh = await getx86_64GzBinary();

    downloader.pointer = () => new Response("Not found", { status: 404 });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.advanceTimersByTime(TTL_MS);

    await expect(getx86_64GzBinary()).resolves.toBe(fresh);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("does not retry the failed refresh on every call", async () => {
    // Serving stale has to also restart the clock, or a downloader outage turns
    // into one failed request per enrolment for as long as it lasts.
    const { getx86_64GzBinary } = await loadModule();
    await getx86_64GzBinary();

    downloader.pointer = () => new Response("Not found", { status: 404 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.advanceTimersByTime(TTL_MS);
    await getx86_64GzBinary();
    await getx86_64GzBinary();

    expect(downloader.latestCalls).toBe(2);
  });

  it("rejects when the first resolve fails and there is nothing cached", async () => {
    downloader.pointer = () => {
      throw new TypeError("fetch failed");
    };
    const { getx86_64GzBinary } = await loadModule();

    await expect(getx86_64GzBinary()).rejects.toThrow(/latest pointer/);
  });

  it("retries after a failed cold resolve rather than latching the rejection", async () => {
    const { getx86_64GzBinary } = await loadModule();
    downloader.pointer = () => new Response("nope", { status: 500 });
    await expect(getx86_64GzBinary()).rejects.toThrow(/HTTP 500/);

    downloader.pointer = () => ok(HASH_A);
    expect(gunzipSync(await getx86_64GzBinary()).toString("latin1")).toBe(X86_PAYLOAD);
  });

  it("refuses a pointer that is not a sha256 digest", async () => {
    // The pointer decides the next URL fetched, so a bucket serving an error
    // page must not become a request path.
    downloader.pointer = () => ok("<!doctype html><title>404</title>");
    const { getx86_64GzBinary } = await loadModule();

    await expect(getx86_64GzBinary()).rejects.toThrow(/not a sha256 hex digest/);
    expect(downloader.archiveCalls).toEqual([]);
  });

  it("names the architecture an archive is missing", async () => {
    downloader.pointer = () => ok(HASH_B);
    const { getArm64GzBinary } = await loadModule();

    await expect(getArm64GzBinary()).rejects.toThrow(/iwappd-aarch64-unknown-linux-musl/);
  });
});
