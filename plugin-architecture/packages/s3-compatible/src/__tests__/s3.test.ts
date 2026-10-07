import { describe, expect, it } from "vitest";
import {
  contentMd5,
  corsXml,
  lifecycleXml,
  md5,
  parseCors,
  parseLifecycle,
  parseObjectLock,
  S3Client,
} from "../s3.js";
import { signV4 } from "../sigv4.js";

describe("sigv4", () => {
  it("matches AWS's published GET Object example", async () => {
    const headers = await signV4({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      headers: { Range: "bytes=0-9" },
      accessKey: "AKIAIOSFODNN7EXAMPLE",
      secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "s3",
      date: new Date("2013-05-24T00:00:00Z"),
    });
    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("encodes an object key exactly once", async () => {
    const a = await signV4({
      method: "GET",
      url: "https://h/b/my%20file.txt",
      headers: {},
      accessKey: "A",
      secretKey: "S",
      region: "r",
      service: "s3",
      date: new Date("2020-01-01T00:00:00Z"),
    });
    const b = await signV4({
      method: "GET",
      url: "https://h/b/my%2520file.txt",
      headers: {},
      accessKey: "A",
      secretKey: "S",
      region: "r",
      service: "s3",
      date: new Date("2020-01-01T00:00:00Z"),
    });
    expect(a["authorization"]).not.toBe(b["authorization"]);
  });
});

describe("md5", () => {
  it("matches RFC 1321 vectors", () => {
    const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    expect(hex(md5(new Uint8Array(0)))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(hex(md5(new TextEncoder().encode("The quick brown fox jumps over the lazy dog")))).toBe(
      "9e107d9d372bb6826bd81d3542a419d6",
    );
    expect(contentMd5("abc")).toBe("kAFQmDzST7DWlj99KOF/cg==");
    const long = new TextEncoder().encode("a".repeat(1000));
    expect(hex(md5(long))).toBe("cabe45dcc9ae5b66ba86600cca6b8ba8");
  });
});

describe("xml", () => {
  it("round-trips lifecycle rules", () => {
    const rules = [
      {
        id: "r1",
        enabled: true,
        prefix: "logs/",
        expirationDays: 30,
        noncurrentDays: 7,
        abortMultipartDays: 2,
      },
    ];
    expect(parseLifecycle(lifecycleXml(rules))).toEqual(rules);
    expect(
      parseLifecycle(
        "<LifecycleConfiguration><Rule><ID>x</ID><Prefix>a/</Prefix><Status>Disabled</Status><Expiration><ExpiredObjectDeleteMarker>true</ExpiredObjectDeleteMarker></Expiration></Rule></LifecycleConfiguration>",
      ),
    ).toEqual([{ id: "x", enabled: false, prefix: "a/", expiredDeleteMarker: true }]);
  });

  it("round-trips CORS and escapes", () => {
    const rules = [
      {
        id: "a&b",
        allowedOrigins: ["https://x"],
        allowedMethods: ["GET"],
        allowedHeaders: ["*"],
        exposeHeaders: [],
        maxAgeSeconds: 60,
      },
    ];
    expect(corsXml(rules)).toContain("<ID>a&amp;b</ID>");
    expect(parseCors(corsXml(rules))).toEqual(rules);
  });

  it("reads object lock", () => {
    expect(
      parseObjectLock(
        "<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled><Rule><DefaultRetention><Mode>COMPLIANCE</Mode><Years>1</Years></DefaultRetention></Rule></ObjectLockConfiguration>",
      ),
    ).toEqual({ enabled: true, mode: "COMPLIANCE", years: 1 });
  });
});

describe("S3Client", () => {
  it("builds path-style and virtual-hosted URLs", () => {
    const base = { region: "r", accessKey: "a", secretKey: "s" };
    expect(
      new S3Client({ ...base, endpoint: "https://h:9000", pathStyle: true }).url("b", "a b/c", {
        versioning: "",
      }),
    ).toBe("https://h:9000/b/a%20b/c?versioning");
    expect(
      new S3Client({ ...base, endpoint: "https://h", pathStyle: false }).url("b", "", {
        "list-type": "2",
      }),
    ).toBe("https://b.h/?list-type=2");
  });

  it("maps XML errors with status and code, and sends Content-MD5 on config bodies", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const http = {
      async request(req: { url: string; headers: Record<string, string> }) {
        seen.push(req);
        if (req.url.includes("lifecycle")) return { status: 200, headers: {}, body: "" };
        return {
          status: 403,
          headers: {},
          body: "<Error><Code>AccessDenied</Code><Message>no</Message></Error>",
        };
      },
    };
    const s3 = new S3Client({
      endpoint: "https://h",
      region: "r",
      pathStyle: true,
      accessKey: "a",
      secretKey: "s",
      http: http as never,
    });
    await s3.putLifecycle("b", [{ id: "x", enabled: true, prefix: "", expirationDays: 1 }]);
    expect(seen[0]!.headers["content-md5"]).toBeTruthy();
    expect(seen[0]!.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256/);
    const err = await s3.listBuckets().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 403, code: "AccessDenied" });
  });
});
