import { describe, expect, it } from "vitest";
import { S3CompatibleClient, normalizeEndpoint } from "../client.js";
import { detectServer } from "../minio.js";
import { plugin } from "../plugin.js";

type Req = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
};

function client(
  route: (u: URL, r: Req) => { status?: number; body?: string; headers?: Record<string, string> },
  extra: Record<string, string> = {},
) {
  const calls: Req[] = [];
  const http = {
    async request(req: Req) {
      calls.push(req);
      const r = route(new URL(req.url), req);
      return { status: r.status ?? 200, headers: r.headers ?? {}, body: r.body ?? "" };
    },
  };
  return {
    c: new S3CompatibleClient(
      { endpoint: "minio.lan:9000/", accessKey: "a", secretKey: "s", ...extra },
      { http } as never,
    ),
    calls,
  };
}

const LIST =
  "<ListAllMyBucketsResult><Buckets><Bucket><Name>data</Name><CreationDate>2026-01-01T00:00:00Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";
const INFO = JSON.stringify({
  mode: "online",
  deploymentID: "dep-1",
  objects: { count: 5 },
  usage: { size: 100 },
  servers: [
    {
      state: "online",
      endpoint: "node1:9000",
      version: "2025-09-07T16-13-09Z",
      uptime: 7200,
      drives: [{ path: "/data1", state: "ok", usedspace: 10, totalspace: 100 }],
    },
    { state: "offline", endpoint: "node2:9000", drives: [{ path: "/data1", state: "offline" }] },
  ],
});
const USAGE = JSON.stringify({
  objectsCount: 5,
  objectsTotalSize: 100,
  capacity: 200,
  freeCapacity: 100,
  bucketsUsageInfo: { data: { size: 64, objectsCount: 3, versionsCount: 3 } },
});

function minioRoute(u: URL) {
  if (u.pathname === "/minio/admin/v4/info") return { status: 426 };
  if (u.pathname === "/minio/admin/v3/info") return { body: INFO };
  if (u.pathname === "/minio/admin/v3/datausageinfo") return { body: USAGE };
  if (u.searchParams.has("location")) return { body: "<LocationConstraint></LocationConstraint>" };
  if (u.searchParams.has("versioning")) return { body: "<VersioningConfiguration/>" };
  if (
    u.searchParams.has("object-lock") ||
    u.searchParams.has("tagging") ||
    u.searchParams.has("policy")
  ) {
    return { status: 404, body: "<Error><Code>NoSuchThing</Code></Error>" };
  }
  return { body: LIST, headers: { server: "MinIO" } };
}

describe("endpoint", () => {
  it("normalises the endpoint and defaults to path-style", () => {
    expect(normalizeEndpoint("minio.lan:9000/")).toBe("https://minio.lan:9000");
    expect(normalizeEndpoint("http://ceph:7480")).toBe("http://ceph:7480");
    const { c } = client(() => ({}));
    expect(c.cfg.pathStyle).toBe(true);
    expect(c.cfg.region).toBe("us-east-1");
  });

  it("detects server software from the Server header", () => {
    expect(detectServer("MinIO")).toBe("MinIO");
    expect(detectServer("Ceph Object Gateway (squid)")).toBe("Ceph RGW");
    expect(detectServer("Garage/v1.0")).toBe("Garage");
    expect(detectServer(undefined)).toBe("Unknown");
  });

  it("reads MinIO cluster health, falling back from admin v4 to v3", async () => {
    const { c, calls } = client(minioRoute);
    const [ep] = await c.listResources("endpoint", "a1");
    expect(ep!.fields).toMatchObject({
      server: "MinIO",
      serversTotal: 2,
      serversOnline: 1,
      drivesTotal: 2,
      drivesOnline: 1,
      capacityBytes: 200,
      adminApi: "Connected",
    });
    const admin = calls.find((x) => x.url.includes("/minio/admin/v3/info"))!;
    expect(admin.headers["authorization"]).toContain("/us-east-1/s3/aws4_request");
    const servers = await c.listResources("minio-server", "a1");
    expect(servers.map((s) => [s.displayName, s.parentResourceId])).toEqual([
      ["node1:9000", "a1:endpoint:minio.lan:9000"],
      ["node2:9000", "a1:endpoint:minio.lan:9000"],
    ]);
  });

  it("does not call the admin API on other servers", async () => {
    const { c, calls } = client((u) =>
      u.pathname === "/"
        ? { body: LIST, headers: { server: "Ceph Object Gateway" } }
        : { body: "" },
    );
    const [ep] = await c.listResources("endpoint", "a1");
    expect(ep!.fields["server"]).toBe("Ceph RGW");
    expect(calls.some((x) => x.url.includes("/minio/admin"))).toBe(false);
  });
});

describe("buckets", () => {
  it("lists buckets with MinIO usage", async () => {
    const { c } = client(minioRoute);
    const [b] = await c.listResources("bucket", "a1");
    expect(b!.fields).toMatchObject({
      name: "data",
      region: "us-east-1",
      objectLock: false,
      hasPolicy: false,
      sizeBytes: 64,
      objects: 3,
    });
    const series = await c.fetchMetricSeries("bucket", "a1:bucket:data", "a1");
    expect(series.find((s) => s.label === "Objects")!.points[0]!.value).toBe(3);
  });

  it("deletes a folder with one batched DeleteObjects", async () => {
    const { c, calls } = client((u) => {
      if (u.searchParams.get("list-type") === "2") {
        return {
          body: "<ListBucketResult><Contents><Key>dir/a</Key><Size>1</Size></Contents><Contents><Key>dir/</Key><Size>0</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>",
        };
      }
      return { body: "<DeleteResult/>" };
    });
    await c.deleteStorageObject("data", "dir/");
    const del = calls.find((x) => x.method === "POST")!;
    expect(del.url).toBe("https://minio.lan:9000/data?delete");
    expect(String(del.body)).toContain("<Key>dir/a</Key>");
    expect(del.headers["content-md5"]).toBeTruthy();
  });

  it("uses virtual-hosted URLs when asked", async () => {
    const { c, calls } = client(
      () => ({ body: "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>" }),
      { addressing: "virtual" },
    );
    await c.listStorageObjects("data", "");
    expect(calls[0]!.url.startsWith("https://data.minio.lan:9000/?")).toBe(true);
  });

  it("offers the addressing choices", async () => {
    expect((await plugin.listCredentialOptions!("addressing", {})).map((o) => o.id)).toEqual([
      "path",
      "virtual",
    ]);
  });
});
