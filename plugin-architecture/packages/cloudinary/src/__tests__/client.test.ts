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
      if (url.endsWith("/transformations?named=true&max_results=500")) {
        return jsonResponse({
          transformations: [{ name: "thumb", named: true, used: false, derived: [] }],
        });
      }
      if (url.endsWith("/upload_presets?max_results=500") && init?.method !== "PUT") {
        return jsonResponse({
          upload_presets: [{ name: "unsigned_images", unsigned: true, settings: {} }],
        });
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

  it("skips the PUT when the preset already carries the named transformation", async () => {
    // Regression: the lister used to JSON-stringify the setting, so the stored
    // field was `"\"t_thumb\""` and this comparison could never hold — every
    // attach re-issued the write against an already-attached preset.
    installFetch((url, init) => {
      if (url.endsWith("/transformations?named=true&max_results=500")) {
        return jsonResponse({
          transformations: [{ name: "thumb", named: true, used: false, derived: [] }],
        });
      }
      if (url.endsWith("/upload_presets?max_results=500") && init?.method !== "PUT") {
        return jsonResponse({
          upload_presets: [
            { name: "unsigned_images", unsigned: true, settings: { transformation: "t_thumb" } },
          ],
        });
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

    expect(calls.find((c) => c.init?.method === "PUT")).toBeUndefined();
  });

  it("stores a string transformation verbatim and a structured one as JSON", async () => {
    installFetch((url) => {
      if (url.includes("/upload_presets")) {
        return jsonResponse({
          upload_presets: [
            { name: "named", unsigned: true, settings: { transformation: "t_thumb" } },
            {
              name: "structured",
              unsigned: true,
              settings: { transformation: [{ width: 100, crop: "fill" }] },
            },
          ],
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const presets = await client().listResources("upload-preset", ACCOUNT);
    expect(presets.find((p) => p.displayName === "named")?.fields["transformation"]).toBe(
      "t_thumb",
    );
    expect(presets.find((p) => p.displayName === "structured")?.fields["transformation"]).toBe(
      '[{"width":100,"crop":"fill"}]',
    );
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

describe("createResource", () => {
  it("creates named transformations on the documented transformation endpoint", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/transformations/thumb") && init?.method === "POST") {
        return jsonResponse({});
      }
      throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
    });

    const created = await client().createResource("transformation", ACCOUNT, {
      name: "thumb",
      transformation: "w_200,h_200,c_fill",
    });

    expect(created.id).toBe(`${ACCOUNT}:transformation:thumb`);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.cloudinary.com/v1_1/demo/transformations/thumb");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      transformation: "w_200,h_200,c_fill",
    });
  });
});

describe("listResources", () => {
  it("paginates media asset lists per resource type", async () => {
    installFetch((url) => {
      if (url.endsWith("/resources/image?max_results=500")) {
        return jsonResponse({
          resources: [
            {
              asset_id: "asset-1",
              public_id: "hero",
              format: "jpg",
              version: 1,
              resource_type: "image",
              type: "upload",
              created_at: "2026-06-01T00:00:00Z",
              bytes: 1024,
              url: "http://res.cloudinary.com/demo/image/upload/hero.jpg",
              secure_url: "https://res.cloudinary.com/demo/image/upload/hero.jpg",
            },
          ],
          next_cursor: "page-2",
        });
      }
      if (url.endsWith("/resources/image?max_results=500&next_cursor=page-2")) {
        return jsonResponse({
          resources: [
            {
              asset_id: "asset-2",
              public_id: "gallery/second",
              format: "png",
              version: 1,
              resource_type: "image",
              type: "upload",
              created_at: "2026-06-02T00:00:00Z",
              bytes: 2048,
              url: "http://res.cloudinary.com/demo/image/upload/gallery/second.png",
              secure_url: "https://res.cloudinary.com/demo/image/upload/gallery/second.png",
            },
          ],
        });
      }
      if (
        url.endsWith("/resources/video?max_results=500") ||
        url.endsWith("/resources/raw?max_results=500")
      ) {
        return jsonResponse({ resources: [] });
      }
      throw new Error(`unrouted: GET ${url}`);
    });

    const resources = await client().listResources("media-asset", ACCOUNT);

    expect(resources.map((resource) => resource.displayName)).toEqual(["hero", "second"]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.cloudinary.com/v1_1/demo/resources/image?max_results=500",
      "https://api.cloudinary.com/v1_1/demo/resources/image?max_results=500&next_cursor=page-2",
      "https://api.cloudinary.com/v1_1/demo/resources/video?max_results=500",
      "https://api.cloudinary.com/v1_1/demo/resources/raw?max_results=500",
    ]);
  });

  it("paginates upload presets and accepts Cloudinary response envelopes", async () => {
    installFetch((url) => {
      if (url.endsWith("/upload_presets?max_results=500")) {
        return jsonResponse({
          upload_presets: [{ name: "signed_uploads", unsigned: false, settings: {} }],
          next_cursor: "next",
        });
      }
      if (url.endsWith("/upload_presets?max_results=500&next_cursor=next")) {
        return jsonResponse({
          presets: [{ name: "unsigned_uploads", unsigned: true, settings: { folder: "ugc" } }],
        });
      }
      throw new Error(`unrouted: GET ${url}`);
    });

    const presets = await client().listResources("upload-preset", ACCOUNT);

    expect(presets.map((preset) => preset.displayName)).toEqual([
      "signed_uploads",
      "unsigned_uploads",
    ]);
    expect(presets[1]!.fields["folder"]).toBe("ugc");
  });

  it("paginates named transformations", async () => {
    installFetch((url) => {
      if (url.endsWith("/transformations?named=true&max_results=500")) {
        return jsonResponse({
          transformations: [{ name: "thumb", named: true, used: true, derived: [{}] }],
          next_cursor: "more",
        });
      }
      if (url.endsWith("/transformations?named=true&max_results=500&next_cursor=more")) {
        return jsonResponse({
          transformations: [{ name: "banner", named: true, used: false, derived: [] }],
        });
      }
      throw new Error(`unrouted: GET ${url}`);
    });

    const transformations = await client().listResources("transformation", ACCOUNT);

    expect(transformations.map((transformation) => transformation.displayName)).toEqual([
      "thumb",
      "banner",
    ]);
  });
});
