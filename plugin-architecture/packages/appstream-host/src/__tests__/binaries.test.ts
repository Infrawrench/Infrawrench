import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { createIwappdBinarySource } from "../binaries.js";

/**
 * The behaviours the web server has always needed — pointer, TTL, stale-serving
 * — are covered end-to-end by `web/src/services/__tests__/iwappd-binaries.test.ts`,
 * which exercises this module through that wrapper. What is covered here is the
 * part only the desktop uses: the bundled `iwappd.tar.xz` behind the network,
 * which is what a laptop with no route to the downloader stages, and what must
 * NOT keep being staged once the downloader answers again — that failure mode
 * (an installed app forever serving the build it shipped with) is the reason
 * the runtime source exists.
 */

const ORIGIN = "https://iwappd-hash-asset-downloader.infrawrench.com";
const TTL_MS = 10 * 60 * 1000;

const HASH_A = "a".repeat(64);

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
let errors: ReturnType<typeof vi.spyOn>;

function ok(body: Buffer | string): Response {
  return new Response(body as unknown as BodyInit, { status: 200 });
}

const offline = () => {
  throw new TypeError("fetch failed");
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-18T12:00:00Z"));

  downloader = {
    pointer: offline,
    archives: { [HASH_A]: ARCHIVE_BOTH },
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

  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errors.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createIwappdBinarySource with a bundled archive", () => {
  it("serves the bundled binaries when the downloader is unreachable", async () => {
    const source = createIwappdBinarySource({ bundledArchive: async () => ARCHIVE_BOTH });

    expect(gunzipSync(await source.getx86_64GzBinary()).toString("latin1")).toBe(X86_PAYLOAD);
    expect(gunzipSync(await source.getArm64GzBinary()).toString("latin1")).toBe(ARM_PAYLOAD);
    expect(errors).toHaveBeenCalled();
  });

  it("does not re-read the bundled archive inside the TTL", async () => {
    // The fallback restarts the clock, or an offline laptop would pay one
    // failed pointer request per session for as long as it stays offline.
    const bundledArchive = vi.fn(async () => ARCHIVE_BOTH);
    const source = createIwappdBinarySource({ bundledArchive });
    await source.getx86_64GzBinary();

    vi.advanceTimersByTime(TTL_MS - 1);
    await source.getArm64GzBinary();

    expect(bundledArchive).toHaveBeenCalledTimes(1);
    expect(downloader.latestCalls).toBe(1);
  });

  it("upgrades from the bundled build once the downloader answers", async () => {
    // The whole point of the runtime source: an installed app must not keep
    // staging the build it shipped with after a newer one is published. The
    // bundled entry records no hash, so the first successful pointer read
    // always downloads the published archive.
    const source = createIwappdBinarySource({ bundledArchive: async () => ARCHIVE_BOTH });
    await source.getx86_64GzBinary();
    expect(downloader.archiveCalls).toEqual([]);

    downloader.pointer = () => ok(HASH_A);
    vi.advanceTimersByTime(TTL_MS);

    expect(gunzipSync(await source.getArm64GzBinary()).toString("latin1")).toBe(ARM_PAYLOAD);
    expect(downloader.archiveCalls).toEqual([HASH_A]);
  });

  it("prefers the published build over the bundled one when both are reachable", async () => {
    const bundledArchive = vi.fn(async () => ARCHIVE_ONLY_X86);
    downloader.pointer = () => ok(HASH_A);
    const source = createIwappdBinarySource({ bundledArchive });

    expect(gunzipSync(await source.getArm64GzBinary()).toString("latin1")).toBe(ARM_PAYLOAD);
    expect(bundledArchive).not.toHaveBeenCalled();
  });

  it("keeps serving a downloaded build over re-reading the bundle when a refresh fails", async () => {
    downloader.pointer = () => ok(HASH_A);
    const bundledArchive = vi.fn(async () => ARCHIVE_ONLY_X86);
    const source = createIwappdBinarySource({ bundledArchive });
    const fresh = await source.getx86_64GzBinary();

    downloader.pointer = offline;
    vi.advanceTimersByTime(TTL_MS);

    await expect(source.getx86_64GzBinary()).resolves.toBe(fresh);
    expect(bundledArchive).not.toHaveBeenCalled();
  });

  it("names the architecture the bundled archive is missing", async () => {
    const source = createIwappdBinarySource({ bundledArchive: async () => ARCHIVE_ONLY_X86 });

    await expect(source.getArm64GzBinary()).rejects.toThrow(
      /bundled iwappd\.tar\.xz is missing iwappd-aarch64-unknown-linux-musl/,
    );
  });

  it("retries after a failed bundled read rather than latching the rejection", async () => {
    let broken = true;
    const source = createIwappdBinarySource({
      bundledArchive: async () => {
        if (broken) throw new Error("ENOENT: iwappd.tar.xz");
        return ARCHIVE_BOTH;
      },
    });
    await expect(source.getx86_64GzBinary()).rejects.toThrow(/ENOENT/);

    broken = false;
    expect(gunzipSync(await source.getx86_64GzBinary()).toString("latin1")).toBe(X86_PAYLOAD);
  });
});

describe("createIwappdBinarySource without a bundled archive", () => {
  it("rejects on a cold start when the downloader is unreachable", async () => {
    // The web server's situation: nothing bundled, so there is genuinely
    // nothing to serve.
    const source = createIwappdBinarySource();

    await expect(source.getx86_64GzBinary()).rejects.toThrow(/latest pointer/);
  });
});
