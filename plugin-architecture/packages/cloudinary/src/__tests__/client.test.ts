import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudinaryClient } from "../client.js";

const ACCOUNT = "acct-1";

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
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function installFetch(handler: (url: string, init?: RequestInit) => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (
    url: string,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), ...(init !== undefined && { init }) });
    return handler(String(url), init);
  }) as typeof fetch);
}

function client() {
  return new CloudinaryClient({ cloudName: "demo", apiKey: "key", apiSecret: "secret" });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("attachResource", () => {
  it("applies a named transformation to an upload preset", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/transformations?named=true")) {
        return jsonResponse({
          transformations: [{ name: "thumb", named: true, used: false, derived: [] }],
        });
      }
      if (url.endsWith("/upload_presets") && init?.method !== "PUT") {
        return jsonResponse([{ name: "unsigned_images", unsigned: true, settings: {} }]);
      }
      if (url.endsWith("/upload_presets/unsigned_images") && init?.method === "PUT") {
        return jsonResponse({});
      }
      throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
    });

    await client().attachResource(
      "transformation",
      `${ACCOUNT}:transformation:thumb`,
      "upload-preset",
      `${ACCOUNT}:upload-preset:unsigned_images`,
      ACCOUNT,
    );

    const put = calls.find((c) => c.url.endsWith("/upload_presets/unsigned_images"));
    expect(put).toBeTruthy();
    expect(put!.init?.method).toBe("PUT");
    expect(JSON.parse(put!.init?.body as string)).toEqual({ transformation: "t_thumb" });
  });

  it("throws for an unsupported attach pair", async () => {
    await expect(
      client().attachResource(
        "folder",
        `${ACCOUNT}:folder:assets`,
        "upload-preset",
        `${ACCOUNT}:upload-preset:preset`,
        ACCOUNT,
      ),
    ).rejects.toThrow(/attachResource not supported/);
  });
});
