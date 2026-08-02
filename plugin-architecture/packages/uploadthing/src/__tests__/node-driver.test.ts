import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";

const mockMkdirSync = vi.fn();
const mockCreateWriteStream = vi.fn();
const mockUnlink = vi.fn(async (_path: string) => {});

vi.mock("node:fs", () => ({
  default: {
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    createWriteStream: (...args: unknown[]) => mockCreateWriteStream(...args),
    promises: { unlink: (p: string) => mockUnlink(p) },
  },
}));

const mockPipeline = vi.fn(async () => {});

vi.mock("node:stream/promises", () => ({
  pipeline: (...args: unknown[]) => mockPipeline(...(args as [])),
}));

import { nodeDriver } from "../node-driver.js";

const APP_ID = "abc123app";
const KEY = "aaaa-bbbb";
const API_KEY = "sk_live_test";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let calls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function streamResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: Readable.toWeb(Readable.from([Buffer.from("bytes")])),
  } as unknown as Response;
}

function installFetch(handler: (url: string, init?: RequestInit) => Response) {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init !== undefined && { init }) });
    return handler(String(url), init);
  }) as typeof fetch);
}

beforeEach(() => {
  calls = [];
  mockMkdirSync.mockClear();
  mockCreateWriteStream.mockClear();
  mockUnlink.mockClear();
  mockPipeline.mockClear();
  mockPipeline.mockImplementation(async () => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("nodeDriver", () => {
  it("declares the plugin id the host dispatches on", () => {
    expect(nodeDriver.pluginId).toBe("uploadthing");
  });
});

describe("downloadFile", () => {
  it("mints a per-file grant before fetching bytes", async () => {
    installFetch((url) =>
      url.endsWith("/v6/requestFileAccess")
        ? jsonResponse({ ufsUrl: `https://${APP_ID}.ufs.sh/f/${KEY}?sig=1`, url: "" })
        : streamResponse(),
    );

    await nodeDriver.downloadFile(APP_ID, KEY, API_KEY, "/tmp/out/logo.png");

    expect(calls[0]?.url).toBe("https://api.uploadthing.com/v6/requestFileAccess");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ fileKey: KEY });
    // The presigned URL is what gets fetched — not the composed public one,
    // which 403s for any file whose ACL is private.
    expect(calls[1]?.url).toBe(`https://${APP_ID}.ufs.sh/f/${KEY}?sig=1`);
  });

  it("authenticates the grant with the app key header, not a bearer token", async () => {
    installFetch((url) =>
      url.endsWith("/v6/requestFileAccess")
        ? jsonResponse({ ufsUrl: "https://x.ufs.sh/f/k", url: "" })
        : streamResponse(),
    );

    await nodeDriver.downloadFile(APP_ID, KEY, API_KEY, "/tmp/out/logo.png");

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["x-uploadthing-api-key"]).toBe(API_KEY);
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("does not send the API key to the storage host", async () => {
    installFetch((url) =>
      url.endsWith("/v6/requestFileAccess")
        ? jsonResponse({ ufsUrl: "https://x.ufs.sh/f/k", url: "" })
        : streamResponse(),
    );

    await nodeDriver.downloadFile(APP_ID, KEY, API_KEY, "/tmp/out/logo.png");

    expect(calls[1]?.init).toBeUndefined();
  });

  it("falls back to the deprecated utfs.io url when ufsUrl is empty", async () => {
    installFetch((url) =>
      url.endsWith("/v6/requestFileAccess")
        ? jsonResponse({ ufsUrl: "", url: `https://utfs.io/f/${KEY}` })
        : streamResponse(),
    );

    await nodeDriver.downloadFile(APP_ID, KEY, API_KEY, "/tmp/out/logo.png");

    expect(calls[1]?.url).toBe(`https://utfs.io/f/${KEY}`);
  });

  it("creates the destination directory before writing", async () => {
    installFetch((url) =>
      url.endsWith("/v6/requestFileAccess")
        ? jsonResponse({ ufsUrl: "https://x.ufs.sh/f/k", url: "" })
        : streamResponse(),
    );

    await nodeDriver.downloadFile(APP_ID, KEY, API_KEY, "/tmp/deep/nested/logo.png");

    expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/deep/nested", { recursive: true });
  });

  it("surfaces a failed grant rather than fetching nothing", async () => {
    installFetch(() => jsonResponse({ error: "Invalid API key" }, 401));

    await expect(
      nodeDriver.downloadFile(APP_ID, KEY, API_KEY, "/tmp/out/logo.png"),
    ).rejects.toThrow(/401/);
    expect(calls).toHaveLength(1);
  });

  it("errors when the grant comes back with no url at all", async () => {
    installFetch(() => jsonResponse({ ufsUrl: "", url: "" }));

    await expect(
      nodeDriver.downloadFile(APP_ID, KEY, API_KEY, "/tmp/out/logo.png"),
    ).rejects.toThrow(/no download URL/);
  });

  it("surfaces a failed byte fetch", async () => {
    installFetch((url) =>
      url.endsWith("/v6/requestFileAccess")
        ? jsonResponse({ ufsUrl: "https://x.ufs.sh/f/k", url: "" })
        : streamResponse(404),
    );

    await expect(
      nodeDriver.downloadFile(APP_ID, KEY, API_KEY, "/tmp/out/logo.png"),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("removes the partial file when the stream breaks mid-write", async () => {
    installFetch((url) =>
      url.endsWith("/v6/requestFileAccess")
        ? jsonResponse({ ufsUrl: "https://x.ufs.sh/f/k", url: "" })
        : streamResponse(),
    );
    mockPipeline.mockImplementation(async () => {
      throw new Error("socket hang up");
    });

    // A truncated file left on disk is worse than a failed download — it looks
    // like the real thing.
    await expect(
      nodeDriver.downloadFile(APP_ID, KEY, API_KEY, "/tmp/out/logo.png"),
    ).rejects.toThrow(/socket hang up/);
    expect(mockUnlink).toHaveBeenCalledWith("/tmp/out/logo.png");
  });
});
