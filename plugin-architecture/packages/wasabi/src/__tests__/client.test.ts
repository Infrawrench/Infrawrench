import { describe, expect, it } from "vitest";
import { WasabiClient, corsFromFields, lifecycleFromFields } from "../client.js";
import { costRows, usdPerGibDay } from "../usage.js";
import { mapComponent, parseStatusFeed } from "../status-feed.js";

type Req = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
};

function client(
  route: (u: URL, r: Req) => { status?: number; body?: string },
  creds: Record<string, string> = {},
) {
  const calls: Req[] = [];
  const http = {
    async request(req: Req) {
      calls.push(req);
      const r = route(new URL(req.url), req);
      return { status: r.status ?? 200, headers: {}, body: r.body ?? "" };
    },
  };
  return {
    c: new WasabiClient({ accessKey: "AK", secretKey: "SK", ...creds }, { http } as never),
    calls,
  };
}

const LIST =
  "<ListAllMyBucketsResult><Buckets><Bucket><Name>photos</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";

describe("buckets", () => {
  it("resolves each bucket's region and talks to its regional endpoint", async () => {
    const { c, calls } = client((u) => {
      if (u.host === "stats.wasabisys.com") {
        return {
          body: JSON.stringify({
            PageInfo: { PageCount: 1 },
            Records: [
              {
                StartTime: "2026-10-05T00:00:00Z",
                Bucket: "photos",
                PaddedStorageSizeBytes: 2 * 1024 ** 3,
                NumBillableObjects: 9,
                Region: "eu-central-2",
              },
            ],
          }),
        };
      }
      if (u.searchParams.has("location"))
        return { body: "<LocationConstraint>eu-central-2</LocationConstraint>" };
      if (u.searchParams.has("versioning"))
        return {
          body: "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>",
        };
      if (u.searchParams.has("object-lock"))
        return {
          status: 404,
          body: "<Error><Code>ObjectLockConfigurationNotFoundError</Code></Error>",
        };
      if (u.searchParams.has("tagging"))
        return {
          body: "<Tagging><TagSet><Tag><Key>env</Key><Value>prod</Value></Tag></TagSet></Tagging>",
        };
      return { body: LIST };
    });
    const [b] = await c.listResources("bucket", "a1");
    expect(b!.fields).toMatchObject({
      region: "eu-central-2",
      versioning: "Enabled",
      objectLock: false,
      tags: "env=prod",
      activeStorageGib: 2,
      objects: 9,
    });
    const versioning = calls.find((x) => x.url.includes("versioning"))!;
    expect(versioning.url).toBe("https://s3.eu-central-2.wasabisys.com/photos?versioning");
    expect(versioning.headers["authorization"]).toContain("/eu-central-2/s3/aws4_request");
    const stats = calls.find((x) => x.url.includes("stats.wasabisys.com"))!;
    expect(stats.headers["Authorization"]).toBe("AK:SK");
  });

  it("lists sub-accounts only with a WAC key, sending it bare", async () => {
    const none = client(() => ({ body: "[]" }));
    expect(await none.c.listResources("sub-account", "a1")).toEqual([]);
    const { c, calls } = client(
      () => ({ body: JSON.stringify([{ AcctNum: 42, AcctName: "x@example.com", IsTrial: true }]) }),
      { wacApiKey: "WAC" },
    );
    const subs = await c.listResources("sub-account", "a1");
    expect(subs[0]!.externalId).toBe("42");
    expect(calls[0]!.url).toBe("https://partner.wasabisys.com/v1/accounts");
    expect(calls[0]!.headers["Authorization"]).toBe("WAC");
  });

  it("signs IAM calls for service iam", async () => {
    const { c, calls } = client(() => ({
      body: "<ListUsersResponse><ListUsersResult><Users></Users><IsTruncated>false</IsTruncated></ListUsersResult></ListUsersResponse>",
    }));
    expect(await c.listResources("iam-user", "a1")).toEqual([]);
    expect(calls[0]!.url).toBe("https://iam.wasabisys.com/");
    expect(String(calls[0]!.body)).toContain("Action=ListUsers");
    expect(calls[0]!.headers["authorization"]).toContain("/us-east-1/iam/aws4_request");
  });
});

describe("mappers and pricing", () => {
  it("validates rules", () => {
    expect(() => lifecycleFromFields({ ruleId: "x" })).toThrow(/at least one/);
    expect(
      corsFromFields({ ruleId: "c", allowedOrigins: "*", allowedMethods: '["get"]' })
        .allowedMethods,
    ).toEqual(["GET"]);
    expect(() =>
      corsFromFields({ ruleId: "c", allowedOrigins: "*", allowedMethods: "PATCH" }),
    ).toThrow();
  });

  it("prices active and deleted storage per GiB-day at the date's list price", () => {
    expect(usdPerGibDay("2026-08-01")).toBeCloseTo(7.99 / 1024 / 30, 10);
    expect(usdPerGibDay("2026-06-01")).toBeCloseTo(6.99 / 1024 / 30, 10);
    const rows = costRows(
      [
        {
          StartTime: "2026-08-01T00:00:00Z",
          Bucket: "1.photos",
          Region: "us-east-1",
          PaddedStorageSizeBytes: 1024 ** 4,
          DeletedStorageSizeBytes: 1024 ** 3,
        },
      ],
      ["photos"],
    );
    expect(rows.map((r) => [r.service, r.resourceId])).toEqual([
      ["Active storage", "photos"],
      ["Timed deleted storage", "photos"],
    ]);
    expect(rows[0]!.amount).toBeCloseTo(7.99 / 30, 4);
  });
});

describe("status feed", () => {
  it("maps region components", () => {
    expect(mapComponent("US-Central-1 (Texas)")).toMatchObject({ regions: ["us-central-1"] });
    expect(mapComponent("US-East-1-Dell-OBS (N. Virginia)")).toMatchObject({
      regions: ["us-east-1"],
    });
    expect(mapComponent("Wasabi Console")).toMatchObject({ providerWide: true });
    const out = parseStatusFeed(
      JSON.stringify({
        incidents: [
          {
            id: "i1",
            name: "Slow uploads",
            status: "investigating",
            impact: "minor",
            components: [{ name: "EU-Central-2 (Frankfurt)" }],
          },
        ],
      }),
    );
    expect(out[0]!.regions).toEqual(["eu-central-2"]);
  });
});
