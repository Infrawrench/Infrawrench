import { describe, expect, it, vi } from "vitest";

/**
 * The cost export egress guard, and the store-side validation that feeds it.
 * A destination is a URL an org member typed, fetched from inside the cluster,
 * so what has to hold is that no spelling of it reaches an internal address.
 */

let dnsAnswers: Array<{ address: string; family: number }> = [];

vi.mock("node:dns", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns")>()),
  lookup: (
    _host: string,
    _opts: unknown,
    cb: (err: Error | null, addrs: Array<{ address: string; family: number }>) => void,
  ) => cb(null, dnsAnswers),
}));

vi.mock("../db/client", () => ({ db: {} }));
vi.mock("../db/schema", () => ({ costExports: {} }));
vi.mock("../encryption", () => ({
  buildAad: () => "",
  encrypt: async () => ({}),
  decrypt: async () => "",
}));

const { assertDestinationUrl, guardedLookup, isBlockedAddress, normalizeS3Endpoint } =
  await import("../cost-exports/egress");
const { normalizeDestination, CostExportInputError } = await import("../cost-exports/store");

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["52.216.0.1", "1.1.1.1", "2606:4700:4700::1111"])("allows %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("assertDestinationUrl", () => {
  it("accepts a public https URL", () => {
    expect(assertDestinationUrl("https://wh.example.com/a?sig=x").host).toBe("wh.example.com");
  });

  it.each([
    "http://wh.example.com/",
    "ftp://wh.example.com/",
    "https://user:pw@wh.example.com/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://[::ffff:a9fe:a9fe]/",
    "https://169.254.169.254/",
    "https://localhost/",
    "https://metadata.localhost/",
    "not a url",
  ])("refuses %s", (url) => {
    expect(() => assertDestinationUrl(url)).toThrow();
  });
});

describe("normalizeS3Endpoint", () => {
  it("accepts a bare host or an https origin", () => {
    expect(normalizeS3Endpoint("")).toBe("");
    expect(normalizeS3Endpoint("fra1.digitaloceanspaces.com")).toBe(
      "https://fra1.digitaloceanspaces.com",
    );
    expect(normalizeS3Endpoint("https://minio.example.com:9000/")).toBe(
      "https://minio.example.com:9000",
    );
  });

  it.each([
    "http://minio.example.com",
    "https://u@minio.example.com",
    "https://minio.example.com/path",
    "https://minio.example.com?x=1",
    "10.0.0.5:9000",
  ])("refuses %s", (endpoint) => {
    expect(() => normalizeS3Endpoint(endpoint)).toThrow();
  });
});

describe("guardedLookup", () => {
  function lookup(all: boolean): Promise<unknown> {
    return new Promise((resolve, reject) => {
      guardedLookup("dest.example.com", { all }, (err: Error | null, address: unknown) =>
        err ? reject(err) : resolve(address),
      );
    });
  }

  it("hands the socket the vetted address", async () => {
    dnsAnswers = [{ address: "52.216.0.1", family: 4 }];
    await expect(lookup(false)).resolves.toBe("52.216.0.1");
    await expect(lookup(true)).resolves.toEqual(dnsAnswers);
  });

  it("refuses a name with any internal answer", async () => {
    dnsAnswers = [
      { address: "52.216.0.1", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ];
    await expect(lookup(false)).rejects.toThrow(/private or reserved/);
  });
});

describe("normalizeDestination (store)", () => {
  const s3 = { kind: "s3", bucket: "finance", prefix: "", region: "eu-west-2", endpoint: "" };

  it("accepts a normal S3 destination", () => {
    expect(normalizeDestination(s3, undefined)).toMatchObject({ region: "eu-west-2" });
    expect(normalizeDestination({ ...s3, region: "" }, undefined)).toMatchObject({
      region: "us-east-1",
    });
    expect(
      normalizeDestination({ ...s3, endpoint: "https://acct.r2.cloudflarestorage.com" }, undefined),
    ).toMatchObject({ endpoint: "https://acct.r2.cloudflarestorage.com" });
  });

  it.each([
    { region: "x@evil.example:443/" },
    { region: "EU-WEST-2" },
    { region: "a".repeat(33) },
    { endpoint: "http://minio.example.com" },
    { endpoint: "https://127.0.0.1" },
    { endpoint: "https://u:p@minio.example.com" },
  ])("refuses %o", (patch) => {
    expect(() => normalizeDestination({ ...s3, ...patch }, undefined)).toThrow(
      CostExportInputError,
    );
  });

  it.each([
    "http://wh.example.com/",
    "https://10.0.0.5/ingest",
    "https://user:pw@wh.example.com/",
    "https://localhost/",
  ])("refuses an HTTPS destination of %s", (url) => {
    expect(() => normalizeDestination({ kind: "http", method: "POST" }, url)).toThrow(
      CostExportInputError,
    );
  });
});
