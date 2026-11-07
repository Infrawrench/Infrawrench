import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportResourcesToTerraform } from "@infrawrench/plugin-base";
import { B2ApiError, coarseRegionOf, s3RegionOf } from "../api.js";
import {
  BackblazeB2Client,
  corsFromFields,
  lifecycleFromFields,
  mergeNotification,
  validateBucketName,
} from "../client.js";
import { bucketFields } from "../mappers.js";
import { b2TerraformExport } from "../terraform.js";
import type { B2Bucket } from "../types.js";

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

type Reply = { status?: number; body?: unknown; text?: string };
type Route = (url: URL, method: string, body?: unknown) => Reply;

const AUTH = {
  accountId: "acct1",
  authorizationToken: "tok-1",
  apiInfo: {
    storageApi: {
      apiUrl: "https://api004.backblazeb2.com",
      downloadUrl: "https://f004.backblazeb2.com",
      s3ApiUrl: "https://s3.us-west-004.backblazeb2.com",
      allowed: { buckets: null, capabilities: ["listBuckets", "writeBuckets"], namePrefix: null },
    },
  },
};

function client(route: Route, secrets?: Map<string, string>, authorize?: () => Reply | undefined) {
  const calls: Call[] = [];
  const http = {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
    }) {
      const url = new URL(req.url);
      let body: unknown;
      if (typeof req.body === "string" && req.body) {
        try {
          body = JSON.parse(req.body);
        } catch {
          body = req.body;
        }
      }
      calls.push({ url, method: req.method, headers: req.headers, body });
      if (url.pathname.endsWith("/b2_authorize_account")) {
        const refused = authorize?.();
        if (refused) {
          return {
            status: refused.status ?? 200,
            headers: {},
            body: JSON.stringify(refused.body),
          };
        }
        return { status: 200, headers: {}, body: JSON.stringify(AUTH) };
      }
      const reply = route(url, req.method, body);
      return {
        status: reply.status ?? 200,
        headers: {},
        body: reply.text ?? (reply.body === undefined ? "" : JSON.stringify(reply.body)),
      };
    },
  };
  const services = {
    http,
    ...(secrets
      ? {
          secrets: {
            async getPlaintext(id: string, key: string) {
              return secrets.get(`${id}|${key}`) ?? null;
            },
            async setPlaintext(id: string, key: string, value: string) {
              secrets.set(`${id}|${key}`, value);
            },
          },
        }
      : {}),
  };
  return {
    c: hostClient(
      new BackblazeB2Client(
        { applicationKeyId: "kid", applicationKey: "secret" },
        services as never,
      ),
    ),
    calls,
  };
}

const BUCKET: B2Bucket = {
  accountId: "acct1",
  bucketId: "b1",
  bucketName: "photos-bucket",
  bucketType: "allPrivate",
  bucketInfo: { "Cache-Control": "max-age=60" },
  corsRules: [],
  lifecycleRules: [
    { fileNamePrefix: "logs/", daysFromHidingToDeleting: 1, daysFromUploadingToHiding: null },
  ],
  defaultServerSideEncryption: {
    isClientAuthorizedToRead: "true",
    value: { mode: "SSE-B2", algorithm: "AES256" },
  },
  fileLockConfiguration: {
    isClientAuthorizedToRead: true,
    value: {
      isFileLockEnabled: "true",
      defaultRetention: { mode: "governance", period: { duration: 1, unit: "years" } },
    },
  },
  replicationConfiguration: { isClientAuthorizedToRead: true, value: null },
  revision: "7",
  options: ["s3"],
};

describe("auth and transport", () => {
  it("authorizes with Basic auth and sends the token on later calls", async () => {
    const { c, calls } = client(() => ({ body: { buckets: [BUCKET] } }));
    const list = await c.listResources("bucket", "a1");
    expect(list).toHaveLength(1);
    const auth = calls[0]!;
    expect(auth.url.href).toBe("https://api.backblazeb2.com/b2api/v4/b2_authorize_account");
    expect(auth.headers["Authorization"]).toBe(`Basic ${btoa("kid:secret")}`);
    const listCall = calls[1]!;
    expect(listCall.url.href).toBe("https://api004.backblazeb2.com/b2api/v4/b2_list_buckets");
    expect(listCall.headers["Authorization"]).toBe("tok-1");
    expect(listCall.body).toEqual({ accountId: "acct1" });
  });

  it("re-authorizes once on an expired token", async () => {
    let n = 0;
    const { c, calls } = client(() => {
      n++;
      if (n === 1)
        return {
          status: 401,
          body: { status: 401, code: "expired_auth_token", message: "expired" },
        };
      return { body: { buckets: [] } };
    });
    await c.listResources("bucket", "a1");
    expect(calls.filter((x) => x.url.pathname.endsWith("b2_authorize_account"))).toHaveLength(2);
  });

  it("maps errors to B2ApiError with status and code", async () => {
    const { c } = client(() => ({
      status: 403,
      body: { status: 403, code: "unauthorized", message: "nope" },
    }));
    const err = await c.listResources("bucket", "a1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(B2ApiError);
    expect((err as B2ApiError).status).toBe(403);
    expect((err as B2ApiError).code).toBe("unauthorized");
  });

  it("derives regions from the S3 endpoint", () => {
    expect(s3RegionOf("https://s3.eu-central-003.backblazeb2.com")).toBe("eu-central-003");
    expect(coarseRegionOf("eu-central-003")).toBe("eu-central");
  });
});

describe("mappers", () => {
  it("reads guarded settings and converts years of retention to days", () => {
    const f = bucketFields(BUCKET, { s3Region: "us-west-004", region: "us-west" });
    expect(f["encryption"]).toBe("SSE-B2");
    expect(f["objectLock"]).toBe(true);
    expect(f["retentionMode"]).toBe("governance");
    expect(f["retentionDays"]).toBe(365);
    expect(f["cacheControl"]).toBe("max-age=60");
    expect(f["revision"]).toBe(7);
  });

  it("leaves settings the key cannot read absent", () => {
    const f = bucketFields(
      { ...BUCKET, defaultServerSideEncryption: { isClientAuthorizedToRead: false } },
      { s3Region: "", region: "" },
    );
    expect(f["encryption"]).toBeUndefined();
  });

  it("validates names and rules", () => {
    expect(validateBucketName("ok-bucket-1")).toBeNull();
    expect(validateBucketName("b2-reserved")).toMatch(/reserved/);
    expect(validateBucketName("abc")).toMatch(/6 to 50/);
    expect(() => lifecycleFromFields({ fileNamePrefix: "x" })).toThrow(/at least one/);
    expect(
      corsFromFields({
        corsRuleName: "allow-app",
        allowedOrigins: "https://a.com",
        allowedOperations: '["s3_get"]',
      }),
    ).toMatchObject({ allowedOperations: ["s3_get"], maxAgeSeconds: 3600 });
  });

  it("keeps the signing secret when a notification is edited", () => {
    const next = mergeNotification(
      {
        name: "hook",
        eventTypes: ["b2:ObjectCreated:*"],
        isEnabled: true,
        objectNamePrefix: "",
        targetConfiguration: {
          targetType: "webhook",
          url: "https://a.example/x",
          hmacSha256SigningSecret: "S".repeat(32),
        },
      },
      { url: "https://b.example/y" },
    );
    expect(next.targetConfiguration.url).toBe("https://b.example/y");
    expect(next.targetConfiguration.hmacSha256SigningSecret).toBe("S".repeat(32));
  });
});

describe("rules as child resources", () => {
  it("lists lifecycle rules with bucket-scoped ids", async () => {
    const { c } = client(() => ({ body: { buckets: [BUCKET] } }));
    const rules = await c.listResources("lifecycle-rule", "a1");
    expect(rules[0]!.externalId).toBe("b1/logs/");
    expect(rules[0]!.parentResourceId).toBe("a1:bucket:b1");
  });

  it("updates a lifecycle rule with ifRevisionIs", async () => {
    const { c, calls } = client((url, _m, body) => {
      if (url.pathname.endsWith("b2_list_buckets")) return { body: { buckets: [BUCKET] } };
      if (url.pathname.endsWith("b2_update_bucket")) {
        return {
          body: { ...BUCKET, lifecycleRules: (body as { lifecycleRules: unknown }).lifecycleRules },
        };
      }
      return { status: 404 };
    });
    const r = await c.updateResource("lifecycle-rule", "a1:lifecycle-rule:b1/logs/", "a1", {
      daysFromHidingToDeleting: "30",
    });
    const update = calls.find((x) => x.url.pathname.endsWith("b2_update_bucket"))!;
    expect(update.body).toMatchObject({
      accountId: "acct1",
      bucketId: "b1",
      ifRevisionIs: 7,
      lifecycleRules: [{ fileNamePrefix: "logs/", daysFromHidingToDeleting: 30 }],
    });
    expect(r.fields["daysFromHidingToDeleting"]).toBe(30);
  });

  it("creates same-account replication by minting both keys", async () => {
    const dest = { ...BUCKET, bucketId: "b2", bucketName: "backup-bucket", lifecycleRules: [] };
    let keys = 0;
    const { c, calls } = client((url, _m, body) => {
      const b = body as Record<string, unknown> | undefined;
      if (url.pathname.endsWith("b2_list_buckets")) {
        return { body: { buckets: [b?.["bucketId"] === "b2" ? dest : BUCKET] } };
      }
      if (url.pathname.endsWith("b2_create_key")) {
        keys++;
        return {
          body: {
            applicationKeyId: `key${keys}`,
            applicationKey: "s",
            keyName: "k",
            capabilities: [],
            accountId: "acct1",
          },
        };
      }
      if (url.pathname.endsWith("b2_update_bucket")) return { body: { ...BUCKET, ...b } };
      return { status: 404 };
    });
    await c.createResource(
      "replication-rule",
      "a1",
      { replicationRuleName: "to-backup", destinationBucketId: "b2" },
      "a1:bucket:b1",
    );
    const updates = calls
      .filter((x) => x.url.pathname.endsWith("b2_update_bucket"))
      .map((x) => x.body as Record<string, unknown>);
    expect(updates[0]).toMatchObject({
      bucketId: "b2",
      replicationConfiguration: {
        asReplicationDestination: { sourceToDestinationKeyMapping: { key1: "key2" } },
      },
    });
    expect(updates[1]).toMatchObject({
      bucketId: "b1",
      replicationConfiguration: {
        asReplicationSource: {
          sourceApplicationKeyId: "key1",
          replicationRules: [
            { replicationRuleName: "to-backup", destinationBucketId: "b2", isEnabled: true },
          ],
        },
      },
    });
  });

  it("stores a created key's secret for the applicationKey output", async () => {
    const secrets = new Map<string, string>();
    const { c } = client((url) => {
      if (url.pathname.endsWith("b2_create_key")) {
        return {
          body: {
            applicationKeyId: "newkey",
            applicationKey: "K-secret",
            keyName: "ci",
            capabilities: ["listFiles"],
            accountId: "acct1",
          },
        };
      }
      return { body: { buckets: [] } };
    }, secrets);
    const res = await c.createResource("application-key", "a1", {
      keyName: "ci",
      capabilities: '["listFiles"]',
    });
    const id = "resource" in res ? res.resource.id : res.id;
    expect(await c.resolveOutput("application-key", id, "applicationKey", "a1")).toBe("K-secret");
  });
});

describe("storage browser", () => {
  it("lists folders and files, hiding the folder placeholder", async () => {
    const { c } = client((url) => {
      if (url.pathname.endsWith("b2_list_buckets")) return { body: { buckets: [BUCKET] } };
      return {
        body: {
          files: [
            { fileName: "a/", action: "folder" },
            { fileName: "a/.bzEmpty", action: "upload", contentLength: 0 },
            {
              fileName: "a/x.txt",
              action: "upload",
              contentLength: 5,
              uploadTimestamp: 0,
              fileId: "f1",
            },
          ],
          nextFileName: null,
        },
      };
    });
    const out = await c.listStorageObjects("photos-bucket", "a/");
    expect(out.map((o) => [o.name, o.isDirectory])).toEqual([
      ["", true],
      ["x.txt", false],
    ]);
  });
});

describe("terraform", () => {
  it("renders rule lists as dynamic blocks", () => {
    const f = bucketFields(BUCKET, { s3Region: "us-west-004", region: "us-west" });
    const outcome = exportResourcesToTerraform(
      [
        {
          id: "a1:bucket:b1",
          pluginId: "backblaze-b2",
          resourceTypeId: "bucket",
          accountId: "a1",
          displayName: "photos-bucket",
          fields: f,
          resolvedOutputs: {},
          secretStates: [],
          externalId: "b1",
          createdAt: "",
          updatedAt: "",
        },
      ],
      () => b2TerraformExport,
    );
    const hcl = outcome.hcl;
    expect(hcl).toContain('dynamic "lifecycle_rules"');
    expect(hcl).toContain("lifecycle_rules.value.file_name_prefix");
    expect(hcl).toContain("terraform import b2_bucket.photos_bucket b1");
  });
});

describe("lists that cannot say they have every row", () => {
  const KEY = { applicationKeyId: "k1", keyName: "one", capabilities: [], accountId: "acct1" };
  const REPORTS = { bucketId: "r1", bucketName: "b2-reports-acct1" };
  const COST_RANGE = { fromDate: "2026-09-01", toDate: "2026-09-30" };

  it("throws at the application key cap, after exactly 10 pages of the largest size", async () => {
    const { c, calls } = client((url) => {
      if (url.pathname.endsWith("b2_list_buckets")) return { body: { buckets: [] } };
      return { body: { keys: [KEY], nextApplicationKeyId: "more" } };
    });
    await expect(c.listResources("application-key", "a1")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    const reads = calls.filter((x) => x.url.pathname.endsWith("b2_list_keys"));
    expect(reads).toHaveLength(10);
    expect(reads[0]!.url.searchParams.get("maxKeyCount")).toBe("10000");
  });

  it("refuses a page of keys that is not a list, first or later", async () => {
    const first = client((url) => {
      if (url.pathname.endsWith("b2_list_buckets")) return { body: { buckets: [] } };
      return { body: { applicationKeys: [KEY] } };
    });
    await expect(first.c.listResources("application-key", "a1")).rejects.toThrow("is not a list");

    let page = 0;
    const later = client((url) => {
      if (url.pathname.endsWith("b2_list_buckets")) return { body: { buckets: [] } };
      page++;
      return page === 1
        ? { body: { keys: [KEY], nextApplicationKeyId: "more" } }
        : { body: { applicationKeys: [KEY] } };
    });
    await expect(later.c.listResources("application-key", "a1")).rejects.toThrow("is not a list");
  });

  it("refuses an answer with no bucket list instead of pruning every bucket", async () => {
    const { c } = client(() => ({ body: { items: [BUCKET] } }));
    await expect(c.listResources("bucket", "a1")).rejects.toThrow("is not a list");
    const empty = client(() => ({ text: "" }));
    await expect(empty.c.listResources("bucket", "a1")).rejects.toThrow("is not a list");
  });

  it("refuses notification rules that are not a list, which an edit would write back", async () => {
    const { c } = client((url) => {
      if (url.pathname.endsWith("b2_list_buckets")) return { body: { buckets: [BUCKET] } };
      return { body: { rules: [] } };
    });
    await expect(c.listResources("notification-rule", "a1")).rejects.toThrow("is not a list");
  });

  it("throws at the usage report file cap instead of pricing part of a month", async () => {
    const { c, calls } = client((url) => {
      if (url.pathname.endsWith("b2_list_buckets")) return { body: { buckets: [REPORTS] } };
      if (url.pathname.endsWith("b2_list_file_names")) {
        return { body: { files: [], nextFileName: "more" } };
      }
      throw new Error(`unexpected ${url.href}`);
    });
    await expect(c.fetchCostData("a1", COST_RANGE)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    const reads = calls.filter((x) => x.url.pathname.endsWith("b2_list_file_names"));
    expect(reads).toHaveLength(20);
    expect(reads[0]!.body).toMatchObject({ maxFileCount: 10000, prefix: "2026-09-" });
  });

  it("refuses a usage report page that is not a list, first or later", async () => {
    const first = client((url) => {
      if (url.pathname.endsWith("b2_list_buckets")) return { body: { buckets: [REPORTS] } };
      return { body: { objects: [] } };
    });
    await expect(first.c.fetchCostData("a1", COST_RANGE)).rejects.toThrow("is not a list");

    let page = 0;
    const later = client((url) => {
      if (url.pathname.endsWith("b2_list_buckets")) return { body: { buckets: [REPORTS] } };
      page++;
      return page === 1 ? { body: { files: [], nextFileName: "more" } } : { body: { objects: [] } };
    });
    await expect(later.c.fetchCostData("a1", COST_RANGE)).rejects.toThrow("is not a list");
  });

  it("does not report a missing reports bucket when the answer has no bucket list", async () => {
    const { c } = client(() => ({ body: { items: [REPORTS] } }));
    await expect(c.fetchCostData("a1", COST_RANGE)).rejects.toThrow("is not a list");
  });

  it("refuses a file browser page that is not a list", async () => {
    const { c } = client((url) => {
      if (url.pathname.endsWith("b2_list_buckets")) return { body: { buckets: [BUCKET] } };
      return { body: { objects: [] } };
    });
    await expect(c.listStorageObjects("photos-bucket", "a/")).rejects.toThrow("is not a list");
  });
});

describe("asking for buckets", () => {
  const restrictedAuth = {
    status: 200,
    body: {
      ...AUTH,
      apiInfo: {
        storageApi: {
          ...AUTH.apiInfo.storageApi,
          allowed: {
            buckets: [
              { id: "b1", name: "photos-bucket" },
              { id: "b2", name: "two" },
            ],
            capabilities: ["listBuckets"],
            namePrefix: null,
          },
        },
      },
    },
  };

  it("asks for each allowed bucket by id when the key is restricted", async () => {
    const { c, calls } = client(
      (_url, _m, body) => {
        const id = (body as { bucketId?: string }).bucketId;
        // B2 denies the all-buckets form to a restricted key.
        if (!id) return { status: 401, body: { status: 401, code: "unauthorized", message: "no" } };
        return {
          body: {
            buckets: id === "b1" ? [BUCKET] : [{ ...BUCKET, bucketId: "b2", bucketName: "two" }],
          },
        };
      },
      undefined,
      () => restrictedAuth,
    );
    const rows = await c.listResources("bucket", "a1");
    expect(rows.map((r) => r.externalId)).toEqual(["b1", "b2"]);
    expect(calls.filter((x) => x.url.pathname.endsWith("b2_list_buckets"))).toHaveLength(2);
  });

  it("reads an allowed bucket that no longer exists as gone", async () => {
    const { c } = client(
      (_url, _m, body) =>
        (body as { bucketId?: string }).bucketId === "b1"
          ? { body: { buckets: [BUCKET] } }
          : { body: { buckets: [] } },
      undefined,
      () => restrictedAuth,
    );
    const rows = await c.listResources("bucket", "a1");
    expect(rows.map((r) => r.externalId)).toEqual(["b1"]);
  });

  it("asks for every bucket with one call when the key is not restricted", async () => {
    const { c, calls } = client(() => ({ body: { buckets: [BUCKET] } }));
    await c.listResources("bucket", "a1");
    const reads = calls.filter((x) => x.url.pathname.endsWith("b2_list_buckets"));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.body).toMatchObject({ accountId: "acct1" });
    expect(reads[0]!.body).not.toHaveProperty("bucketId");
  });
});

describe("deleting from the file browser", () => {
  it("deletes nothing and throws when a folder has more versions than it reads", async () => {
    const { c, calls } = client((url) => {
      if (url.pathname.endsWith("b2_list_buckets")) return { body: { buckets: [BUCKET] } };
      if (url.pathname.endsWith("b2_list_file_versions")) {
        return {
          body: {
            files: [{ fileName: "a/x", fileId: "f1" }],
            nextFileName: "a/y",
            nextFileId: "f2",
          },
        };
      }
      return { body: {} };
    });
    await expect(c.deleteStorageObject("photos-bucket", "a/")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls.filter((x) => x.url.pathname.endsWith("b2_list_file_versions"))).toHaveLength(200);
    expect(calls.some((x) => x.url.pathname.endsWith("b2_delete_file_version"))).toBe(false);
  });

  it("deletes nothing when a page of versions is not a list", async () => {
    const { c, calls } = client((url) => {
      if (url.pathname.endsWith("b2_list_buckets")) return { body: { buckets: [BUCKET] } };
      return { body: { versions: [] } };
    });
    await expect(c.deleteStorageObject("photos-bucket", "a/")).rejects.toThrow("is not a list");
    expect(calls.some((x) => x.url.pathname.endsWith("b2_delete_file_version"))).toBe(false);
  });

  it("deletes every version of one file and stops at the next name", async () => {
    const { c, calls } = client((url) => {
      if (url.pathname.endsWith("b2_list_buckets")) return { body: { buckets: [BUCKET] } };
      if (url.pathname.endsWith("b2_list_file_versions")) {
        return {
          body: {
            files: [
              { fileName: "a/x", fileId: "f1" },
              { fileName: "a/x", fileId: "f2" },
            ],
            nextFileName: "a/x2",
            nextFileId: "f3",
          },
        };
      }
      return { body: {} };
    });
    await c.deleteStorageObject("photos-bucket", "a/x");
    expect(calls.filter((x) => x.url.pathname.endsWith("b2_list_file_versions"))).toHaveLength(1);
    expect(
      calls.filter((x) => x.url.pathname.endsWith("b2_delete_file_version")).map((x) => x.body),
    ).toEqual([
      { fileName: "a/x", fileId: "f1" },
      { fileName: "a/x", fileId: "f2" },
    ]);
  });
});

describe("a refused or failed read", () => {
  const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");
  const refused = { status: 401, body: { status: 401, code: "unauthorized", message: "no" } };
  const expired = { status: 401, body: { status: 401, code: "expired_auth_token", message: "x" } };
  const capped = {
    status: 403,
    body: { status: 403, code: "transaction_cap_exceeded", message: "cap" },
  };
  const server = { status: 500, body: { status: 500, code: "internal_error", message: "boom" } };
  const RULE = { name: "r1", eventTypes: ["b2:ObjectCreated:*"], targetConfiguration: {} };
  const B2 = { ...BUCKET, bucketId: "b2", bucketName: "two" };
  const B3 = { ...BUCKET, bucketId: "b3", bucketName: "three" };
  const COST_RANGE = { fromDate: "2026-09-01", toDate: "2026-09-30" };

  function tracked() {
    const unread = vi.fn();
    Reflect.set(globalThis, UNREAD_HOOK, unread);
    return unread;
  }

  /** Notification rules per bucket, with the given answer for bucket b2. */
  const rulesWith = (forB2: Reply): Route => {
    return (url) => {
      if (url.pathname.endsWith("b2_list_buckets")) {
        return { body: { buckets: [BUCKET, B2, B3] } };
      }
      if (url.searchParams.get("bucketId") === "b2") return forB2;
      return { body: { eventNotificationRules: [RULE] } };
    };
  };

  afterEach(() => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
  });

  it("keeps a refused bucket's notification rules and still reads the others", async () => {
    const unread = tracked();
    const { c } = client(rulesWith(refused));
    const rows = await c.listResources("notification-rule", "a1");
    expect(rows.map((r) => r.parentResourceId).sort()).toEqual(["a1:bucket:b1", "a1:bucket:b3"]);
    expect(unread).toHaveBeenCalledWith({ parentResourceIds: ["a1:bucket:b2"] });
  });

  it("shows the refusal where no host keeps the rows", async () => {
    const { c } = client(rulesWith(refused));
    await expect(c.listResources("notification-rule", "a1")).rejects.toThrow("unauthorized");
  });

  it.each([
    ["an expired token", expired],
    ["a transaction cap", capped],
    ["a server error", server],
  ])("fails the notification rules on %s rather than reading none", async (_name, reply) => {
    const unread = tracked();
    const { c } = client(rulesWith(reply));
    await expect(c.listResources("notification-rule", "a1")).rejects.toBeInstanceOf(B2ApiError);
    expect(unread).not.toHaveBeenCalled();
  });

  it("keeps a whole type's rows when the key lacks its capability", async () => {
    const unread = tracked();
    const keys = client((url) =>
      url.pathname.endsWith("b2_list_keys") ? refused : { body: { buckets: [BUCKET] } },
    );
    await expect(keys.c.listResources("application-key", "a1")).resolves.toEqual([]);
    expect(unread).toHaveBeenCalledWith({ idPrefixes: [""] });

    unread.mockClear();
    const buckets = client(() => refused);
    await expect(buckets.c.listResources("bucket", "a1")).resolves.toEqual([]);
    expect(unread).toHaveBeenCalledWith({ idPrefixes: [""] });
  });

  it("shows a whole type's refusal where no host keeps the rows", async () => {
    const { c } = client(() => refused);
    await expect(c.listResources("bucket", "a1")).rejects.toThrow("unauthorized");
  });

  it("fails a type on a wrong key, which authorize also answers as unauthorized", async () => {
    const unread = tracked();
    const { c } = client(
      () => ({ body: { buckets: [] } }),
      undefined,
      () => refused,
    );
    await expect(c.listResources("bucket", "a1")).rejects.toMatchObject({ status: 401 });
    expect(unread).not.toHaveBeenCalled();
  });

  it("fails a type when a key is revoked mid-session", async () => {
    const unread = tracked();
    let authorizations = 0;
    const { c } = client(
      () => expired,
      undefined,
      () => (authorizations++ === 0 ? undefined : refused),
    );
    await expect(c.listResources("bucket", "a1")).rejects.toMatchObject({ status: 401 });
    expect(authorizations).toBe(2);
    expect(unread).not.toHaveBeenCalled();
  });

  it("shows the account row for a key that cannot list buckets, and fails on anything else", async () => {
    const ok = client(() => refused);
    const [row] = await ok.c.listResources("account", "a1");
    expect(row!.fields["bucketCount"]).toBe(0);
    const bad = client(() => capped);
    await expect(bad.c.listResources("account", "a1")).rejects.toMatchObject({ status: 403 });
  });

  it("reads only a refusal of the reports bucket as a cost setup problem", async () => {
    const setup = client(() => refused);
    await expect(setup.c.fetchCostData("a1", COST_RANGE)).rejects.toMatchObject({
      name: "CostSetupError",
    });
    const cap = client(() => capped);
    await expect(cap.c.fetchCostData("a1", COST_RANGE)).rejects.toMatchObject({ status: 403 });
  });

  it("charts nothing only when there are no usage reports to read", async () => {
    const range = { startMs: Date.parse("2026-09-01"), endMs: Date.parse("2026-09-30") };
    const none = client(() => ({ body: { buckets: [] } }));
    await expect(
      none.c.fetchMetricSeries!("account", "a1:account:x", "a1", range),
    ).resolves.toEqual([]);
    const noRead = client((url) =>
      url.pathname.endsWith("b2_list_buckets")
        ? { body: { buckets: [{ bucketId: "r1", bucketName: "b2-reports-acct1" }] } }
        : refused,
    );
    await expect(
      noRead.c.fetchMetricSeries!("account", "a1:account:x", "a1", range),
    ).resolves.toEqual([]);
    const down = client(() => server);
    await expect(
      down.c.fetchMetricSeries!("account", "a1:account:x", "a1", range),
    ).rejects.toMatchObject({ status: 500 });
  });
});
