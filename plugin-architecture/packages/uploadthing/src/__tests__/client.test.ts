import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UploadThingClient, decodeApiKey } from "../client.js";

const ACCOUNT = "acct-1";
const APP_ID = "abc123app";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let calls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
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

function client(apiKey = "sk_live_test") {
  return new UploadThingClient({ apiKey });
}

const APP_INFO = { appId: APP_ID, defaultACL: "public-read", allowACLOverride: true };

const USAGE = {
  totalBytes: 26_843_545_600,
  appTotalBytes: 1_073_741_824,
  filesUploaded: 2,
  limitBytes: 107_374_182_400,
};

const FILES = [
  {
    id: "id-1",
    customId: null,
    key: "aaaa-bbbb",
    name: "logo.png",
    status: "Uploaded",
    size: 1024,
    uploadedAt: 1_717_213_483_400,
  },
  {
    id: "id-2",
    customId: "my-custom-id",
    key: "cccc-dddd",
    name: "broken.zip",
    status: "Failed",
    size: 0,
    uploadedAt: 1_717_213_483_500,
  },
];

/** Routes the read endpoints every listing path touches. */
function installReadFetch(extra?: (url: string, init?: RequestInit) => Response | undefined) {
  return installFetch((url, init) => {
    const fromExtra = extra?.(url, init);
    if (fromExtra) return fromExtra;
    if (url.endsWith("/v7/getAppInfo")) return jsonResponse(APP_INFO);
    if (url.endsWith("/v6/getUsageInfo")) return jsonResponse(USAGE);
    if (url.endsWith("/v6/listFiles")) return jsonResponse({ hasMore: false, files: FILES });
    if (url.includes("/v6/pollUpload/")) {
      return jsonResponse({
        status: "done",
        fileData: { fileKey: "aaaa-bbbb", fileType: "image/png" },
      });
    }
    throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
  });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("decodeApiKey", () => {
  it("passes a raw sk_live key through untouched", () => {
    expect(decodeApiKey("  sk_live_abc  ")).toEqual({ apiKey: "sk_live_abc" });
  });

  it("unwraps a v7 UPLOADTHING_TOKEN and keeps the region", () => {
    const token = btoa(JSON.stringify({ apiKey: "sk_live_xyz", appId: APP_ID, regions: ["fra1"] }));
    expect(decodeApiKey(token)).toEqual({ apiKey: "sk_live_xyz", region: "fra1" });
  });

  it("falls back to sending the pasted value when it is neither shape", () => {
    // An unusable credential has to reach the API so the user sees UploadThing's
    // own 401 rather than a guess made here.
    expect(decodeApiKey("garbage")).toEqual({ apiKey: "garbage" });
  });
});

describe("authentication", () => {
  it("sends the app-scoped key header, not a bearer token", async () => {
    installReadFetch();
    await client().listResources("ut-app", ACCOUNT);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["x-uploadthing-api-key"]).toBe("sk_live_test");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("POSTs the read endpoints — UploadThing has no GET reads", async () => {
    installReadFetch();
    await client().listResources("ut-app", ACCOUNT);
    for (const call of calls) expect(call.init?.method).toBe("POST");
  });
});

describe("listResources", () => {
  it("returns a single app carrying quota and ACL settings", async () => {
    installReadFetch();
    const [app, ...rest] = await client().listResources("ut-app", ACCOUNT);
    expect(rest).toHaveLength(0);
    expect(app?.id).toBe(`${ACCOUNT}:ut-app:${APP_ID}`);
    expect(app?.fields["filesUploaded"]).toBe(2);
    expect(app?.fields["limitBytes"]).toBe(USAGE.limitBytes);
    expect(app?.fields["allowAclOverride"]).toBe(true);
    expect(app?.resolvedOutputs["appUrl"]).toBe(`https://${APP_ID}.ufs.sh`);
  });

  it("maps files onto the app-scoped ufs.sh URL and parents them to the app", async () => {
    installReadFetch();
    const files = await client().listResources("ut-file", ACCOUNT);
    expect(files).toHaveLength(2);
    expect(files[0]?.fields["ufsUrl"]).toBe(`https://${APP_ID}.ufs.sh/f/aaaa-bbbb`);
    expect(files[0]?.parentResourceId).toBe(`${ACCOUNT}:ut-app:${APP_ID}`);
    expect(files[0]?.fields["sizeLabel"]).toBe("1.0 KB");
    expect(files[1]?.fields["customId"]).toBe("my-custom-id");
  });

  it("converts the epoch-millisecond uploadedAt into an ISO timestamp", async () => {
    installReadFetch();
    const files = await client().listResources("ut-file", ACCOUNT);
    expect(files[0]?.fields["uploadedAt"]).toBe(new Date(1_717_213_483_400).toISOString());
  });

  it("caches getAppInfo across a listing instead of asking once per file", async () => {
    installReadFetch();
    const c = client();
    await c.listResources("ut-file", ACCOUNT);
    await c.listResources("ut-file", ACCOUNT);
    expect(calls.filter((call) => call.url.endsWith("/v7/getAppInfo"))).toHaveLength(1);
  });

  it("pages past 2,000 files — the listing is not capped", async () => {
    // 12 pages of 500. A cap would silently stop at four and the app would
    // look like it holds 2,000 files.
    const TOTAL_PAGES = 12;
    let page = 0;
    installReadFetch((url) => {
      if (!url.endsWith("/v6/listFiles")) return undefined;
      page += 1;
      const files = Array.from({ length: 500 }, (_, i) => ({
        ...FILES[0],
        key: `p${page}-${i}`,
        name: `p${page}-${i}.png`,
      }));
      return jsonResponse({ hasMore: page < TOTAL_PAGES, files });
    });

    const files = await client().listResources("ut-file", ACCOUNT);
    expect(files).toHaveLength(6000);
  });

  it("stops when a server claims hasMore but returns nothing", async () => {
    installReadFetch((url) =>
      url.endsWith("/v6/listFiles") ? jsonResponse({ hasMore: true, files: [] }) : undefined,
    );
    // `hasMore` is the server's word; without the empty-page break this spins.
    await expect(client().listResources("ut-file", ACCOUNT)).resolves.toHaveLength(0);
  });

  it("walks the listing once per client, not once per call site", async () => {
    installReadFetch();
    const c = client();
    await c.listResources("ut-file", ACCOUNT);
    await c.listStorageObjects(APP_ID, "");
    expect(calls.filter((call) => call.url.endsWith("/v6/listFiles"))).toHaveLength(1);
  });

  it("re-walks after a delete so the browser does not show a deleted row", async () => {
    installReadFetch((url) =>
      url.endsWith("/v6/deleteFiles")
        ? jsonResponse({ success: true, deletedCount: 1 })
        : undefined,
    );
    const c = client();
    await c.listStorageObjects(APP_ID, "");
    await c.deleteStorageObject(APP_ID, "aaaa-bbbb");
    await c.listStorageObjects(APP_ID, "");
    expect(calls.filter((call) => call.url.endsWith("/v6/listFiles"))).toHaveLength(2);
  });

  it("pages listFiles by offset until hasMore goes false", async () => {
    let page = 0;
    installReadFetch((url) => {
      if (!url.endsWith("/v6/listFiles")) return undefined;
      page += 1;
      return page === 1
        ? jsonResponse({ hasMore: true, files: FILES })
        : jsonResponse({ hasMore: false, files: [{ ...FILES[0], key: "eeee-ffff" }] });
    });
    const files = await client().listResources("ut-file", ACCOUNT);
    expect(files).toHaveLength(3);
    const bodies = calls
      .filter((c) => c.url.endsWith("/v6/listFiles"))
      .map((c) => JSON.parse(String(c.init?.body)) as { offset: number });
    expect(bodies.map((b) => b.offset)).toEqual([0, 2]);
  });
});

describe("getResource", () => {
  it("enriches a file with the MIME type only pollUpload returns", async () => {
    installReadFetch();
    const file = await client().getResource("ut-file", `${ACCOUNT}:ut-file:aaaa-bbbb`, ACCOUNT);
    expect(file.fields["contentType"]).toBe("image/png");
  });

  it("still returns the file when pollUpload no longer knows about it", async () => {
    installReadFetch((url) =>
      url.includes("/v6/pollUpload/") ? jsonResponse({ error: "not found" }, 404) : undefined,
    );
    const file = await client().getResource("ut-file", `${ACCOUNT}:ut-file:aaaa-bbbb`, ACCOUNT);
    expect(file.displayName).toBe("logo.png");
    expect(file.fields["contentType"]).toBeUndefined();
  });
});

describe("resolveOutput", () => {
  it("mints a signed URL on demand rather than storing one per file", async () => {
    installReadFetch((url) =>
      url.endsWith("/v6/requestFileAccess")
        ? jsonResponse({ ufsUrl: "https://x.ufs.sh/f/aaaa-bbbb?sig=1", url: "https://utfs.io/f/x" })
        : undefined,
    );
    const value = await client().resolveOutput(
      "ut-file",
      `${ACCOUNT}:ut-file:aaaa-bbbb`,
      "signedUrl",
      ACCOUNT,
    );
    expect(value).toBe("https://x.ufs.sh/f/aaaa-bbbb?sig=1");
  });

  it("prefers ufsUrl over the deprecated utfs.io form", async () => {
    installReadFetch((url) =>
      url.endsWith("/v6/requestFileAccess")
        ? jsonResponse({ ufsUrl: "", url: "https://utfs.io/f/aaaa-bbbb" })
        : undefined,
    );
    const value = await client().resolveOutput(
      "ut-file",
      `${ACCOUNT}:ut-file:aaaa-bbbb`,
      "signedUrl",
      ACCOUNT,
    );
    expect(value).toBe("https://utfs.io/f/aaaa-bbbb");
  });
});

describe("mutations", () => {
  it("renames a file through renameFiles keyed by fileKey", async () => {
    installReadFetch((url) =>
      url.endsWith("/v6/renameFiles")
        ? jsonResponse({ success: true, renamedCount: 1 })
        : undefined,
    );
    await client().updateResource("ut-file", `${ACCOUNT}:ut-file:aaaa-bbbb`, ACCOUNT, {
      name: "renamed.png",
    });
    const call = calls.find((c) => c.url.endsWith("/v6/renameFiles"));
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      updates: [{ fileKey: "aaaa-bbbb", newName: "renamed.png" }],
    });
  });

  it("deletes by fileKeys, not by the deprecated file ids", async () => {
    installReadFetch((url) =>
      url.endsWith("/v6/deleteFiles")
        ? jsonResponse({ success: true, deletedCount: 1 })
        : undefined,
    );
    await client().deleteResource("ut-file", `${ACCOUNT}:ut-file:aaaa-bbbb`, ACCOUNT);
    const call = calls.find((c) => c.url.endsWith("/v6/deleteFiles"));
    expect(JSON.parse(String(call?.init?.body))).toEqual({ fileKeys: ["aaaa-bbbb"] });
  });

  it("maps the ACL actions onto updateACL", async () => {
    installReadFetch((url) =>
      url.endsWith("/v6/updateACL") ? jsonResponse({ success: true, updatedCount: 1 }) : undefined,
    );
    await client().invokeAction("ut-file", `${ACCOUNT}:ut-file:aaaa-bbbb`, "make-private", ACCOUNT);
    const call = calls.find((c) => c.url.endsWith("/v6/updateACL"));
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      updates: [{ fileKey: "aaaa-bbbb", acl: "private" }],
    });
  });

  it("rejects an unknown action instead of silently doing nothing", async () => {
    await expect(
      client().invokeAction("ut-file", `${ACCOUNT}:ut-file:aaaa-bbbb`, "nope", ACCOUNT),
    ).rejects.toThrow(/unknown action/);
  });
});

describe("getCreateConfig", () => {
  it("offers the ACL picker when the app allows per-file overrides", async () => {
    installReadFetch();
    const config = await client().getCreateConfig("ut-file");
    expect(config.fields.map((f) => f.key)).toContain("acl");
  });

  it("omits the ACL picker when the app does not allow overrides", async () => {
    installReadFetch((url) =>
      url.endsWith("/v7/getAppInfo")
        ? jsonResponse({ ...APP_INFO, allowACLOverride: false })
        : undefined,
    );
    const config = await client().getCreateConfig("ut-file");
    expect(config.fields.map((f) => f.key)).not.toContain("acl");
  });
});

describe("createResource", () => {
  it("downloads the source URL then PUTs it to the prepared upload target", async () => {
    installReadFetch((url, init) => {
      if (url === "https://example.com/pic.png") {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "image/png" }),
          blob: async () => new Blob([new Uint8Array(4)], { type: "image/png" }),
        } as unknown as Response;
      }
      if (url.endsWith("/v7/prepareUpload")) {
        return jsonResponse({ key: "new-key", url: "https://sea1.ingest.uploadthing.com/new-key" });
      }
      if (url.startsWith("https://sea1.ingest.uploadthing.com/") && init?.method === "PUT") {
        return jsonResponse({ ok: true });
      }
      return undefined;
    });

    const created = await client().createResource("ut-file", ACCOUNT, {
      sourceUrl: "https://example.com/pic.png",
      customId: "cid-1",
      acl: "private",
    });

    expect(created.id).toBe(`${ACCOUNT}:ut-file:new-key`);
    expect(created.displayName).toBe("pic.png");
    expect(created.fields["ufsUrl"]).toBe(`https://${APP_ID}.ufs.sh/f/new-key`);

    const prepare = calls.find((c) => c.url.endsWith("/v7/prepareUpload"));
    expect(JSON.parse(String(prepare?.init?.body))).toMatchObject({
      fileName: "pic.png",
      fileSize: 4,
      fileType: "image/png",
      customId: "cid-1",
      acl: "private",
    });
  });

  it("surfaces a failed download instead of uploading an empty file", async () => {
    installReadFetch((url) =>
      url === "https://example.com/gone.png" ? jsonResponse("nope", 404) : undefined,
    );
    await expect(
      client().createResource("ut-file", ACCOUNT, { sourceUrl: "https://example.com/gone.png" }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

/** An archive upload: nested names sharing a top-level prefix. */
const TREE_FILES = [
  { ...FILES[0], key: "k1", name: "git-cliff-2.12.0/CHANGELOG.md", size: 100 },
  { ...FILES[0], key: "k2", name: "git-cliff-2.12.0/completions/git-cliff.bash", size: 200 },
  { ...FILES[0], key: "k3", name: "git-cliff-2.12.0/completions/git-cliff.fish", size: 300 },
  { ...FILES[0], key: "k4", name: "git-cliff-2.12.0/man/git-cliff.1", size: 50 },
  { ...FILES[0], key: "k5", name: "loose.txt", size: 10 },
];

function installTreeFetch(extra?: (url: string, init?: RequestInit) => Response | undefined) {
  return installReadFetch((url, init) => {
    const fromExtra = extra?.(url, init);
    if (fromExtra) return fromExtra;
    return url.endsWith("/v6/listFiles")
      ? jsonResponse({ hasMore: false, files: TREE_FILES })
      : undefined;
  });
}

describe("storage browser", () => {
  it("lists files at the root when no name carries a path", async () => {
    installReadFetch();
    const objects = await client().listStorageObjects(APP_ID, "");
    expect(objects).toHaveLength(2);
    expect(objects.every((o) => !o.isDirectory)).toBe(true);
    expect(objects[0]?.key).toBe("aaaa-bbbb");
  });

  it("derives one folder per top segment instead of a wall of long names", async () => {
    installTreeFetch();
    const objects = await client().listStorageObjects(APP_ID, "");
    expect(objects.filter((o) => o.isDirectory).map((o) => o.name)).toEqual(["git-cliff-2.12.0"]);
    expect(objects.filter((o) => !o.isDirectory).map((o) => o.name)).toEqual(["loose.txt"]);
  });

  it("gives a folder a trailing-slash key so it can be listed and deleted", async () => {
    installTreeFetch();
    const [dir] = await client().listStorageObjects(APP_ID, "");
    expect(dir?.key).toBe("git-cliff-2.12.0/");
  });

  it("rolls the whole subtree's size and newest timestamp into the folder", async () => {
    installTreeFetch();
    const [dir] = await client().listStorageObjects(APP_ID, "");
    expect(dir?.size).toBe(650);
  });

  it("opens a folder by listing its key", async () => {
    installTreeFetch();
    const objects = await client().listStorageObjects(APP_ID, "git-cliff-2.12.0/");
    expect(objects.filter((o) => o.isDirectory).map((o) => o.name)).toEqual(["completions", "man"]);
    // Leaf names only — the browser already shows the path in its breadcrumb.
    expect(objects.filter((o) => !o.isDirectory).map((o) => o.name)).toEqual(["CHANGELOG.md"]);
  });

  it("nests a second level under the first", async () => {
    installTreeFetch();
    const objects = await client().listStorageObjects(APP_ID, "git-cliff-2.12.0/completions/");
    expect(objects.map((o) => o.name)).toEqual(["git-cliff.bash", "git-cliff.fish"]);
    // Real UploadThing keys — delete and download address files by key.
    expect(objects.map((o) => o.key)).toEqual(["k2", "k3"]);
  });

  it("keeps real file keys on leaves so delete and download still resolve", async () => {
    installTreeFetch();
    const objects = await client().listStorageObjects(APP_ID, "");
    expect(objects.find((o) => o.name === "loose.txt")?.key).toBe("k5");
  });

  it("keeps a folder upload's relative path as the file name", async () => {
    installReadFetch((url, init) => {
      if (url.endsWith("/v7/prepareUpload")) {
        return jsonResponse({ key: "new-key", url: "https://sea1.ingest.uploadthing.com/new-key" });
      }
      if (url.startsWith("https://sea1.ingest.uploadthing.com/") && init?.method === "PUT") {
        return jsonResponse({ ok: true });
      }
      return undefined;
    });

    const file = new File([new Uint8Array(2)], "a.png", { type: "image/png" });
    await client().uploadStorageObject(APP_ID, "photos/sub/a.png", file);

    // Flattening to the leaf would land two `a.png` rows from two subfolders.
    const prepare = calls.find((c) => c.url.endsWith("/v7/prepareUpload"));
    expect(JSON.parse(String(prepare?.init?.body))).toMatchObject({
      fileName: "photos/sub/a.png",
    });
  });

  it("strips a leading slash so names never start with one", async () => {
    installReadFetch((url, init) => {
      if (url.endsWith("/v7/prepareUpload")) {
        return jsonResponse({ key: "new-key", url: "https://sea1.ingest.uploadthing.com/new-key" });
      }
      if (url.startsWith("https://sea1.ingest.uploadthing.com/") && init?.method === "PUT") {
        return jsonResponse({ ok: true });
      }
      return undefined;
    });

    const file = new File([new Uint8Array(2)], "a.png", { type: "image/png" });
    await client().uploadStorageObject(APP_ID, "/photos/a.png", file);

    const prepare = calls.find((c) => c.url.endsWith("/v7/prepareUpload"));
    expect(JSON.parse(String(prepare?.init?.body))).toMatchObject({ fileName: "photos/a.png" });
  });

  it("leaves a plain file upload's name alone", async () => {
    installReadFetch((url, init) => {
      if (url.endsWith("/v7/prepareUpload")) {
        return jsonResponse({ key: "new-key", url: "https://sea1.ingest.uploadthing.com/new-key" });
      }
      if (url.startsWith("https://sea1.ingest.uploadthing.com/") && init?.method === "PUT") {
        return jsonResponse({ ok: true });
      }
      return undefined;
    });

    const file = new File([new Uint8Array(2)], "logo.svg", { type: "image/svg+xml" });
    await client().uploadStorageObject(APP_ID, "logo.svg", file);

    const prepare = calls.find((c) => c.url.endsWith("/v7/prepareUpload"));
    expect(JSON.parse(String(prepare?.init?.body))).toMatchObject({ fileName: "logo.svg" });
  });

  it("explains why an empty folder cannot be created", async () => {
    await expect(client().makeStorageFolder(APP_ID, "images/")).rejects.toThrow(
      /derived from file names/,
    );
  });

  it("deletes every file under a folder key, batched", async () => {
    installTreeFetch((url) =>
      url.endsWith("/v6/deleteFiles")
        ? jsonResponse({ success: true, deletedCount: 3 })
        : undefined,
    );
    await client().deleteStorageObject(APP_ID, "git-cliff-2.12.0/");
    const bodies = calls
      .filter((c) => c.url.endsWith("/v6/deleteFiles"))
      .map((c) => JSON.parse(String(c.init?.body)) as { fileKeys: string[] });
    expect(bodies.flatMap((b) => b.fileKeys)).toEqual(["k1", "k2", "k3", "k4"]);
  });

  it("does not treat a plain file key as a folder", async () => {
    installTreeFetch((url) =>
      url.endsWith("/v6/deleteFiles")
        ? jsonResponse({ success: true, deletedCount: 1 })
        : undefined,
    );
    await client().deleteStorageObject(APP_ID, "k5");
    const body = calls.find((c) => c.url.endsWith("/v6/deleteFiles"))?.init?.body;
    expect(JSON.parse(String(body))).toEqual({ fileKeys: ["k5"] });
  });

  it("skips the delete call entirely for an empty folder", async () => {
    installTreeFetch();
    await client().deleteStorageObject(APP_ID, "nothing-here/");
    expect(calls.some((c) => c.url.endsWith("/v6/deleteFiles"))).toBe(false);
  });
});

describe("renderDetail", () => {
  it("shows the ACL actions when overrides are allowed", async () => {
    installReadFetch();
    const c = client();
    const file = await c.getResource("ut-file", `${ACCOUNT}:ut-file:aaaa-bbbb`, ACCOUNT);
    const labels = c.renderDetail(file).headerActions?.map((a) => a.label);
    expect(labels).toContain("Make public");
    expect(labels).toContain("Make private");
  });

  it("hides the ACL actions when the app forbids overrides", async () => {
    installReadFetch((url) =>
      url.endsWith("/v7/getAppInfo")
        ? jsonResponse({ ...APP_INFO, allowACLOverride: false })
        : undefined,
    );
    const c = client();
    const file = await c.getResource("ut-file", `${ACCOUNT}:ut-file:aaaa-bbbb`, ACCOUNT);
    const labels = c.renderDetail(file).headerActions?.map((a) => a.label);
    expect(labels).not.toContain("Make public");
  });

  it("gives the app a storage browser and keeps files off Overview", async () => {
    installReadFetch();
    const c = client();
    const [app] = await c.listResources("ut-app", ACCOUNT);
    const detail = c.renderDetail(app!);
    // The browser tab is the file listing; an Overview copy would be a second
    // table that disagrees with it once an app passes the sync cap.
    expect(detail.storageBrowser?.bucketName).toBe(APP_ID);
    expect(detail.hiddenChildTypeIds).toContain("ut-file");
    expect(detail.childTables).toBeUndefined();
  });

  it("marks a failed upload as an error in the sidebar", async () => {
    installReadFetch();
    const c = client();
    const files = await c.listResources("ut-file", ACCOUNT);
    expect(c.renderSidebarItem(files[1]!).status?.status).toBe("error");
  });
});
