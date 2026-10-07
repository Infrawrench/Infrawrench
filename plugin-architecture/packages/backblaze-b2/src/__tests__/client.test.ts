import { describe, expect, it } from "vitest";
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

function client(route: Route, secrets?: Map<string, string>) {
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
    c: new BackblazeB2Client(
      { applicationKeyId: "kid", applicationKey: "secret" },
      services as never,
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
