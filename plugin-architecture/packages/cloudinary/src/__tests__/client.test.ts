import { hostClient } from "@infrawrench/plugin-base/effect";
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
  return hostClient(
    new CloudinaryClient({ cloudName: "demo", apiKey: "key", apiSecret: "secret" }),
  );
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
    // field was `"\"t_thumb\""` and this comparison could never hold; every
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
      if (url.endsWith("/resources/image?max_results=500&tags=true")) {
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
      if (url.endsWith("/resources/image?max_results=500&tags=true&next_cursor=page-2")) {
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
        url.endsWith("/resources/video?max_results=500&tags=true") ||
        url.endsWith("/resources/raw?max_results=500&tags=true")
      ) {
        return jsonResponse({ resources: [] });
      }
      throw new Error(`unrouted: GET ${url}`);
    });

    const resources = await client().listResources("media-asset", ACCOUNT);

    expect(resources.map((resource) => resource.displayName)).toEqual(["hero", "second"]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.cloudinary.com/v1_1/demo/resources/image?max_results=500&tags=true",
      "https://api.cloudinary.com/v1_1/demo/resources/image?max_results=500&tags=true&next_cursor=page-2",
      "https://api.cloudinary.com/v1_1/demo/resources/video?max_results=500&tags=true",
      "https://api.cloudinary.com/v1_1/demo/resources/raw?max_results=500&tags=true",
    ]);
  });

  describe("a failed read never reads as an empty list", () => {
    const hero = {
      asset_id: "a1",
      public_id: "hero",
      resource_type: "image",
      type: "upload",
    };

    it("rejects when one asset type is rate limited on its first page", async () => {
      installFetch((url) => {
        if (url.includes("/resources/raw")) {
          return jsonResponse({ error: { message: "Rate limit exceeded" } }, 420);
        }
        return jsonResponse({ resources: url.includes("/resources/image") ? [hero] : [] });
      });
      await expect(client().listResources("media-asset", ACCOUNT)).rejects.toThrow(/420/);
    });

    it("rejects when a later page fails, rather than keep the pages before it", async () => {
      installFetch((url) => {
        if (url.includes("next_cursor=two")) return jsonResponse("Service Unavailable", 503);
        if (url.includes("/resources/image")) {
          return jsonResponse({ resources: [hero], next_cursor: "two" });
        }
        return jsonResponse({ resources: [] });
      });
      await expect(client().listResources("media-asset", ACCOUNT)).rejects.toThrow(/503/);
    });

    it("reads a 404 on an asset type's first page as no assets of that type", async () => {
      installFetch((url) => {
        if (url.includes("/resources/raw")) return jsonResponse({ error: {} }, 404);
        return jsonResponse({ resources: url.includes("/resources/image") ? [hero] : [] });
      });
      const assets = await client().listResources("media-asset", ACCOUNT);
      expect(assets.map((a) => a.displayName)).toEqual(["hero"]);
    });

    it("rejects a 404 on a later page of an asset type", async () => {
      installFetch((url) => {
        if (url.includes("next_cursor=two")) return jsonResponse({ error: {} }, 404);
        if (url.includes("/resources/image")) {
          return jsonResponse({ resources: [hero], next_cursor: "two" });
        }
        return jsonResponse({ resources: [] });
      });
      await expect(client().listResources("media-asset", ACCOUNT)).rejects.toThrow(/404/);
    });

    it("rejects an asset page whose list is not an array", async () => {
      installFetch(() => jsonResponse({ error: { message: "nope" } }));
      await expect(client().listResources("media-asset", ACCOUNT)).rejects.toThrow("is not a list");
    });

    it("rejects an asset list that never ends, after exactly its page cap", async () => {
      installFetch(() => jsonResponse({ resources: [hero], next_cursor: "again" }));
      await expect(client().listResources("media-asset", ACCOUNT)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(calls).toHaveLength(100);
    });

    it("rejects when a folder's subfolders fail, and allows a 404", async () => {
      const root = { folders: [{ name: "a", path: "a" }] };
      installFetch((url) =>
        url.endsWith("/folders") ? jsonResponse(root) : jsonResponse("Server Error", 500),
      );
      await expect(client().listResources("folder", ACCOUNT)).rejects.toThrow(/500/);

      vi.restoreAllMocks();
      installFetch((url) =>
        url.endsWith("/folders") ? jsonResponse(root) : jsonResponse({ error: {} }, 404),
      );
      const folders = await client().listResources("folder", ACCOUNT);
      expect(folders.map((f) => f.displayName)).toEqual(["a"]);
    });
  });

  describe("folders", () => {
    const named = (path: string) => ({ name: path.split("/").pop(), path });

    it("reads every subfolder, 500 at a time, following next_cursor", async () => {
      installFetch((url) => {
        if (url.endsWith("/folders")) return jsonResponse({ folders: [named("a")] });
        if (url.endsWith("/folders/a?max_results=500")) {
          return jsonResponse({ folders: [named("a/one")], next_cursor: "two", total_count: 2 });
        }
        if (url.endsWith("/folders/a?max_results=500&next_cursor=two")) {
          return jsonResponse({ folders: [named("a/two")], next_cursor: null, total_count: 2 });
        }
        throw new Error(`unrouted: GET ${url}`);
      });
      const folders = await client().listResources("folder", ACCOUNT);
      expect(folders.map((f) => f.externalId)).toEqual(["a", "a/one", "a/two"]);
      expect(folders[2]?.parentResourceId).toBe(`${ACCOUNT}:folder:a`);
    });

    it("rejects subfolders that never end, after exactly its page cap", async () => {
      installFetch((url) =>
        url.endsWith("/folders")
          ? jsonResponse({ folders: [named("a")] })
          : jsonResponse({ folders: [named("a/one")], next_cursor: "again" }),
      );
      await expect(client().listResources("folder", ACCOUNT)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(calls.filter((c) => c.url.includes("/folders/a"))).toHaveLength(20);
    });

    it("rejects a subfolder page whose list is not an array, on a later page too", async () => {
      installFetch((url) => {
        if (url.endsWith("/folders")) return jsonResponse({ folders: [named("a")] });
        if (url.includes("next_cursor=two")) return jsonResponse({ error: { message: "x" } });
        return jsonResponse({ folders: [named("a/one")], next_cursor: "two" });
      });
      await expect(client().listResources("folder", ACCOUNT)).rejects.toThrow("is not a list");
    });

    it("rejects a list cut off at the provider's limit of 2000", async () => {
      const rows = Array.from({ length: 2000 }, (_, i) => named(`f${i}`));
      installFetch(() => jsonResponse({ folders: rows, next_cursor: null, total_count: 2001 }));
      await expect(client().listResources("folder", ACCOUNT)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(calls).toHaveLength(1);
    });

    it("rejects root folders that come with a cursor, which the document rules out", async () => {
      installFetch(() => jsonResponse({ folders: [named("a")], next_cursor: "more" }));
      await expect(client().listResources("folder", ACCOUNT)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
    });

    it("rejects a root answer that is not a list", async () => {
      installFetch(() => jsonResponse({ message: "nope" }));
      await expect(client().listResources("folder", ACCOUNT)).rejects.toThrow("is not a list");
    });
  });

  describe.each([
    ["upload-preset", "presets", { name: "p", unsigned: false, settings: {} }],
    ["transformation", "transformations", { name: "t", named: true }],
    ["upload-mapping", "mappings", { folder: "f", template: "https://x.example/" }],
  ])("%s pages", (type, key, row) => {
    it("rejects a list that never ends, after exactly its page cap", async () => {
      installFetch(() => jsonResponse({ [key]: [row], next_cursor: "again" }));
      await expect(client().listResources(type, ACCOUNT)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(calls).toHaveLength(100);
    });

    it("rejects a first page whose list is not there", async () => {
      installFetch(() => jsonResponse({ renamed: [row] }));
      await expect(client().listResources(type, ACCOUNT)).rejects.toThrow("is not a list");
    });

    it("rejects a later page whose list is not there", async () => {
      installFetch((url) =>
        url.includes("next_cursor=two")
          ? jsonResponse({ renamed: [row] })
          : jsonResponse({ [key]: [row], next_cursor: "two" }),
      );
      await expect(client().listResources(type, ACCOUNT)).rejects.toThrow("is not a list");
    });
  });

  it("rejects a trigger answer whose list is not there", async () => {
    installFetch(() => jsonResponse({ renamed: [] }));
    await expect(client().listResources("trigger", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("reads empty lists as empty", async () => {
    installFetch((url) => {
      if (url.includes("/upload_presets")) return jsonResponse({ presets: [] });
      if (url.includes("/transformations")) return jsonResponse({ transformations: [] });
      if (url.includes("/upload_mappings")) return jsonResponse({ mappings: [] });
      if (url.includes("/triggers")) return jsonResponse({ triggers: [], total: 0 });
      throw new Error(`unrouted: GET ${url}`);
    });
    for (const type of ["upload-preset", "transformation", "upload-mapping", "trigger"]) {
      await expect(client().listResources(type, ACCOUNT)).resolves.toEqual([]);
    }
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

describe("webhook notifications (triggers)", () => {
  it("creates a trigger with a parsed JSONLogic filter", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/triggers") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return jsonResponse({ id: "trg1", uri_type: "webhook", ...body });
      }
      throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
    });
    const created = await client().createResource("trigger", ACCOUNT, {
      uri: "https://example.com/hook",
      event_type: "upload",
      additive: "true",
      auth_scheme: "eddsa_v2",
      filter: '{"==": [{"var": "resource_type"}, "image"]}',
      payload_template: "",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      uri: "https://example.com/hook",
      event_type: "upload",
      additive: true,
      auth_scheme: "eddsa_v2",
      filter: { "==": [{ var: "resource_type" }, "image"] },
    });
    expect(created.id).toBe(`${ACCOUNT}:trigger:trg1`);
    expect(created.fields["filter"]).toBe('{"==":[{"var":"resource_type"},"image"]}');
  });

  it("rejects a filter that is not a JSON object before calling the API", async () => {
    installFetch(() => jsonResponse({}));
    await expect(
      client().createResource("trigger", ACCOUNT, {
        uri: "https://example.com/hook",
        event_type: "upload",
        filter: "not json",
      }),
    ).rejects.toThrow(/valid JSON/);
    expect(calls).toHaveLength(0);
  });

  it("updates the URL through `new_uri` and clears a removed filter", async () => {
    installFetch((url, init) => {
      if (init?.method === "PUT") return jsonResponse({ id: "trg1" });
      if (url.endsWith("/triggers")) {
        return jsonResponse({
          triggers: [{ id: "trg1", uri: "https://example.com/new", event_type: "delete" }],
        });
      }
      throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
    });
    await client().updateResource("trigger", `${ACCOUNT}:trigger:trg1`, ACCOUNT, {
      uri: "https://example.com/new",
      filter: "",
    });
    const put = calls.find((c) => c.init?.method === "PUT");
    expect(put?.url).toBe("https://api.cloudinary.com/v1_1/demo/triggers/trg1");
    expect(JSON.parse(String(put?.init?.body))).toEqual({
      new_uri: "https://example.com/new",
      filter: {},
    });
  });

  it("DELETEs a trigger by id", async () => {
    installFetch(() => jsonResponse({ message: "ok" }));
    await client().deleteResource("trigger", `${ACCOUNT}:trigger:trg1`, ACCOUNT);
    expect(calls[0]?.init?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe("https://api.cloudinary.com/v1_1/demo/triggers/trg1");
  });
});

describe("upload mappings", () => {
  it("paginates mappings and deletes by folder query parameter", async () => {
    installFetch((url, init) => {
      if (init?.method === "DELETE") return jsonResponse({ message: "deleted" });
      if (url.endsWith("/upload_mappings?max_results=500")) {
        return jsonResponse({
          mappings: [{ folder: "wiki", template: "https://wiki.example.com/" }],
          next_cursor: "c2",
        });
      }
      if (url.endsWith("/upload_mappings?max_results=500&next_cursor=c2")) {
        return jsonResponse({
          mappings: [{ folder: "cdn", template: "https://cdn.example.com/" }],
        });
      }
      throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
    });
    const mappings = await client().listResources("upload-mapping", ACCOUNT);
    expect(mappings.map((m) => m.resolvedOutputs["template"])).toEqual([
      "https://wiki.example.com/",
      "https://cdn.example.com/",
    ]);
    await client().deleteResource("upload-mapping", `${ACCOUNT}:upload-mapping:wiki`, ACCOUNT);
    expect(calls.at(-1)?.url).toBe(
      "https://api.cloudinary.com/v1_1/demo/upload_mappings?folder=wiki",
    );
  });
});

describe("edits", () => {
  it("moves and retags an asset through its immutable asset id", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/resources/image/upload/hero")) {
        return jsonResponse({
          asset_id: "a1",
          public_id: "hero",
          format: "jpg",
          version: 1,
          resource_type: "image",
          type: "upload",
          created_at: "2026-06-01T00:00:00Z",
          bytes: 10,
          url: "",
          secure_url: "",
        });
      }
      if (url.endsWith("/resources/a1") && init?.method === "PUT") {
        return jsonResponse({
          asset_id: "a1",
          public_id: "hero",
          resource_type: "image",
          type: "upload",
          asset_folder: "campaigns",
          tags: ["summer", "hero"],
        });
      }
      throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
    });
    const updated = await client().updateResource(
      "media-asset",
      `${ACCOUNT}:media-asset:image/upload/hero`,
      ACCOUNT,
      { folder: "campaigns", tags: "summer, hero ," },
    );
    const put = calls.find((c) => c.init?.method === "PUT");
    expect(JSON.parse(String(put?.init?.body))).toEqual({
      asset_folder: "campaigns",
      tags: "summer,hero",
    });
    expect(updated.fields["tags"]).toBe("summer, hero");
  });

  it("renames a folder with to_folder", async () => {
    installFetch((url, init) => {
      if (init?.method === "PUT") {
        return jsonResponse({
          from: { name: "old", path: "a/old" },
          to: { name: "new", path: "a/new" },
        });
      }
      throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
    });
    const renamed = await client().updateResource("folder", `${ACCOUNT}:folder:a/old`, ACCOUNT, {
      path: "a/new",
    });
    expect(calls[0]?.url).toBe(
      "https://api.cloudinary.com/v1_1/demo/folders/a%2Fold?to_folder=a%2Fnew",
    );
    expect(renamed.id).toBe(`${ACCOUNT}:folder:a/new`);
  });

  it("sends a new transformation definition as unsafe_update", async () => {
    installFetch((url, init) => {
      if (init?.method === "PUT") return jsonResponse({ message: "updated" });
      if (url.includes("/transformations?named=true")) {
        return jsonResponse({ transformations: [{ name: "thumb", named: true, used: true }] });
      }
      throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
    });
    await client().updateResource("transformation", `${ACCOUNT}:transformation:thumb`, ACCOUNT, {
      definition: "w_300,c_fill",
      allowedForStrict: "true",
    });
    const put = calls.find((c) => c.init?.method === "PUT");
    expect(put?.url).toBe("https://api.cloudinary.com/v1_1/demo/transformations/thumb");
    expect(JSON.parse(String(put?.init?.body))).toEqual({
      allowed_for_strict: true,
      unsafe_update: "w_300,c_fill",
    });
  });
});

describe("usage", () => {
  const usage = {
    plan: "Free",
    last_updated: "2026-04-01",
    transformations: { usage: 26, credits_usage: 0.03 },
    bandwidth: { usage: 9227721, credits_usage: 0.01 },
    storage: { usage: 295753639, credits_usage: 0.28 },
    credits: { usage: 0.32, limit: 25, used_percent: 1.28 },
    resources: 130,
    derived_resources: 411,
    requests: 43,
    cloudinary_ai: { usage: 20, limit: 15 },
    media_limits: { image_max_size_bytes: 10485760 },
    rate_limit_allowed: 500,
    rate_limit_remaining: 499,
  };

  it("reports credits, add-on allowances and the Admin API budget as quotas", async () => {
    installFetch(() => jsonResponse(usage));
    const quotas = await client().fetchQuotas(ACCOUNT);
    expect(quotas.map((q) => [q.id, q.used, q.limit])).toEqual([
      ["credits", 0.32, 25],
      ["addon/cloudinary_ai", 20, 15],
      ["admin-api-rate-limit", 1, 500],
    ]);
  });

  it("summarises the product environment with its folder mode", async () => {
    installFetch((url) => {
      if (url.endsWith("/usage")) return jsonResponse(usage);
      if (url.endsWith("/config?settings=true")) {
        return jsonResponse({ cloud_name: "demo", settings: { folder_mode: "dynamic" } });
      }
      throw new Error(`unrouted: GET ${url}`);
    });
    const [env] = await client().listResources("product-environment", ACCOUNT);
    expect(env?.fields).toMatchObject({
      plan: "Free",
      folderMode: "dynamic",
      creditsUsed: 0.32,
      creditsLimit: 25,
      storageBytes: 295753639,
      assets: 130,
      imageMaxBytes: 10485760,
    });
  });
});

describe("fetchMetricSeries", () => {
  it("charts one dated usage report per day, skipping days the API refuses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    try {
      installFetch((url) => {
        const date = new URL(url).searchParams.get("date");
        if (date === "2026-10-02") return jsonResponse({ error: { message: "nope" } }, 400);
        return jsonResponse({
          storage: { usage: date === "2026-10-03" ? 2048 : 1024 },
          bandwidth: { usage: 10 },
          transformations: { usage: 5 },
          resources: 3,
          derived_resources: 7,
        });
      });
      const end = Date.parse("2026-10-03T12:00:00Z");
      const series = await client().fetchMetricSeries(
        "product-environment",
        `${ACCOUNT}:product-environment:demo`,
        ACCOUNT,
        { startMs: end - 2 * 24 * 60 * 60 * 1000, endMs: end },
      );
      const dates = calls.map((c) => new URL(c.url).searchParams.get("date")).sort();
      expect(dates).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
      expect(new URL(calls[0]!.url).pathname).toBe("/v1_1/demo/usage");
      const storage = series.find((s) => s.label === "Storage")!;
      expect(storage.unit).toBe("bytes");
      expect(storage.points).toEqual([
        { timestamp: Date.parse("2026-10-01T00:00:00Z"), value: 1024 },
        { timestamp: Date.parse("2026-10-03T00:00:00Z"), value: 2048 },
      ]);
      expect(series.map((s) => s.label)).not.toContain("Credits used");
    } finally {
      vi.useRealTimers();
    }
  });

  it("samples long ranges down to at most 30 days", async () => {
    installFetch(() => jsonResponse({ storage: { usage: 1 } }));
    const end = Date.now();
    await client().fetchMetricSeries(
      "product-environment",
      `${ACCOUNT}:product-environment:demo`,
      ACCOUNT,
      { startMs: end - 90 * 24 * 60 * 60 * 1000, endMs: end },
    );
    expect(calls.length).toBeLessThanOrEqual(30);
    expect(calls.length).toBeGreaterThan(20);
  });

  it("queries video views by public id and time window and buckets them", async () => {
    const start = Date.parse("2026-10-01T00:00:00Z");
    const end = Date.parse("2026-10-02T00:00:00Z");
    installFetch(() =>
      jsonResponse({
        data: [
          {
            video_public_id: "clips/skate",
            view_watch_time: 20,
            view_ended_at: "2026-10-01T05:10:00Z",
          },
          {
            video_public_id: "clips/skate",
            view_watch_time: 5,
            view_ended_at: "2026-10-01T05:40:00Z",
          },
        ],
      }),
    );
    const series = await client().fetchMetricSeries(
      "media-asset",
      `${ACCOUNT}:media-asset:video/upload/clips/skate`,
      ACCOUNT,
      { startMs: start, endMs: end },
    );
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1_1/demo/video/analytics/views");
    expect(url.searchParams.get("expression")).toBe(
      `video_public_id=clips/skate AND view_ended_at>${start / 1000} AND view_ended_at<${end / 1000}`,
    );
    expect(url.searchParams.get("max_results")).toBe("500");
    const views = series.find((s) => s.label === "Views")!;
    const watch = series.find((s) => s.label === "Watch time")!;
    expect(
      views.points.find((p) => p.timestamp === Date.parse("2026-10-01T05:00:00Z"))?.value,
    ).toBe(2);
    expect(watch.points.reduce((t, p) => t + p.value, 0)).toBe(25);
  });

  it("returns nothing for images without calling the API", async () => {
    installFetch(() => jsonResponse({}));
    const series = await client().fetchMetricSeries(
      "media-asset",
      `${ACCOUNT}:media-asset:image/upload/logo`,
      ACCOUNT,
    );
    expect(series).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("bastion routing", () => {
  it("sends every call through the host service, with no CA and no direct fetch", async () => {
    const direct = installFetch(() => jsonResponse({}));
    const request = vi.fn(async (_req: { caCert?: string }) => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ folders: [] }),
    }));
    const hosted = hostClient(
      new CloudinaryClient({ cloudName: "demo", apiKey: "key", apiSecret: "secret" }, {
        http: { request },
      } as never),
    );
    await hosted.listResources("folder", "acct");
    expect(request).toHaveBeenCalled();
    expect(request.mock.calls[0]![0]).not.toHaveProperty("caCert");
    expect(direct).not.toHaveBeenCalled();
  });
});
