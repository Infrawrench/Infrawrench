import { describe, expect, it, vi } from "vitest";
import { makeClient, type Recorded, type Reply } from "./helpers.js";

// These tests read many pages or wait on timers, which runs far slower on CI than locally.
vi.setConfig({ testTimeout: 60_000 });

const ONE_REGION = { regions: "ap-southeast-1" };
const TRUNCATED = "has more than Infrawrench reads";
const NOT_A_LIST = "is not a list";

const vpc = (id: string) => ({ VpcId: id, VpcName: id, CidrBlock: "10.0.0.0/8" });
const vpcs = (n: number, from = 0) => ({
  Vpc: Array.from({ length: n }, (_, i) => vpc(`vpc-${from + i}`)),
});
const disk = (id: string) => ({ DiskId: id, RegionId: "ap-southeast-1" });
const bucketsPage = (extra: string) =>
  `<ListAllMyBucketsResult>${extra}<Buckets><Bucket><Name>b</Name><Region>eu-central-1</Region></Bucket></Buckets></ListAllMyBucketsResult>`;

function listWith(route: (req: Recorded) => Reply | undefined) {
  return makeClient(route, ONE_REGION);
}

describe("a list past its cap throws instead of returning part", () => {
  it("stops a PageNumber list at 1,000 requests of 50", async () => {
    const { client, calls } = listWith((req) =>
      req.action === "DescribeVpcs"
        ? { body: { Vpcs: vpcs(50), TotalCount: 9_000_000 } }
        : undefined,
    );
    await expect(client.listResources("vpc", "acct")).rejects.toThrow(TRUNCATED);
    expect(calls).toHaveLength(1000);
  });

  it("stops a PageNumber list of 500 at 100,000 rows", async () => {
    const { client, calls } = listWith((req) => {
      if (req.action === "DescribeDomains") {
        return { body: { Domains: { Domain: [{ DomainName: "a.example" }] }, TotalCount: 1 } };
      }
      if (req.action === "DescribeDomainRecords") {
        const Record = Array.from({ length: 500 }, (_, i) => ({ RecordId: `r${i}` }));
        return { body: { DomainRecords: { Record }, TotalCount: 9_000_000 } };
      }
      return undefined;
    });
    await expect(client.listResources("dns-record", "acct")).rejects.toThrow(TRUNCATED);
    expect(calls.filter((c) => c.action === "DescribeDomainRecords")).toHaveLength(200);
  });

  it("stops a NextToken list at 1,000 requests of 100", async () => {
    const { client, calls } = listWith((req) =>
      req.action === "DescribeSnapshots"
        ? { body: { Snapshots: { Snapshot: [] }, NextToken: "more" } }
        : undefined,
    );
    await expect(client.listResources("snapshot", "acct")).rejects.toThrow(TRUNCATED);
    expect(calls).toHaveLength(1000);
  });

  it("reads disks at the documented 500 a page, up to 100,000 rows", async () => {
    const { client, calls } = listWith((req) =>
      req.action === "DescribeDisks"
        ? { body: { Disks: { Disk: [disk("d-1")] }, NextToken: "more" } }
        : undefined,
    );
    await expect(client.listResources("disk", "acct")).rejects.toThrow(TRUNCATED);
    expect(calls).toHaveLength(200);
    expect(calls[0]!.params["MaxResults"]).toBe("500");
  });

  it("stops OSS buckets at 50 pages", async () => {
    const { client, calls } = listWith((req) =>
      req.url.host === "oss-ap-southeast-1.aliyuncs.com"
        ? { raw: bucketsPage("<IsTruncated>true</IsTruncated><NextMarker>m</NextMarker>") }
        : undefined,
    );
    await expect(client.listResources("oss-bucket", "acct")).rejects.toThrow(TRUNCATED);
    expect(calls).toHaveLength(50);
  });

  it("stops RAM users at 50 pages", async () => {
    const { client, calls } = listWith((req) =>
      req.action === "ListUsers"
        ? { body: { Users: { User: [] }, IsTruncated: true, Marker: "m" } }
        : undefined,
    );
    await expect(client.listResources("ram-user", "acct")).rejects.toThrow(TRUNCATED);
    expect(calls).toHaveLength(50);
  });

  it("stops a day's bill at 1,000 pages", async () => {
    const { client, calls } = listWith((req) =>
      req.action === "DescribeInstanceBill"
        ? { body: { Success: true, Data: { Items: [], NextToken: "more" } } }
        : undefined,
    );
    await expect(
      client.fetchCostData("acct", { fromDate: "2026-09-01", toDate: "2026-09-01" } as never),
    ).rejects.toThrow(TRUNCATED);
    expect(calls).toHaveLength(1000);
  });

  it("deletes nothing from a folder it cannot list whole", async () => {
    const { client, calls } = listWith((req) =>
      req.method === "GET"
        ? {
            raw: "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t</NextContinuationToken><Contents><Key>f/a</Key></Contents></ListBucketResult>",
          }
        : { status: 204 },
    );
    await expect(client.deleteStorageObject!("eu-central-1/b", "f/")).rejects.toThrow(TRUNCATED);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });
});

describe("a page that says there is more", () => {
  it("is read past a short page when TotalCount has not been reached", async () => {
    const { client } = listWith((req) => {
      if (req.action !== "DescribeVpcs") return undefined;
      return req.params["PageNumber"] === "1"
        ? { body: { Vpcs: vpcs(30), TotalCount: 40 } }
        : { body: { Vpcs: vpcs(10, 30), TotalCount: 40 } };
    });
    expect(await client.listResources("vpc", "acct")).toHaveLength(40);
  });

  it("ends on an empty page, whatever TotalCount says", async () => {
    const { client, calls } = listWith((req) => {
      if (req.action !== "DescribeVpcs") return undefined;
      return req.params["PageNumber"] === "1"
        ? { body: { Vpcs: vpcs(30), TotalCount: 40 } }
        : { body: { Vpcs: { Vpc: [] }, TotalCount: 40 } };
    });
    expect(await client.listResources("vpc", "acct")).toHaveLength(30);
    expect(calls).toHaveLength(2);
  });

  it("refuses IsTruncated with no marker to read on by", async () => {
    const ram = listWith((req) =>
      req.action === "ListUsers" ? { body: { Users: { User: [] }, IsTruncated: true } } : undefined,
    );
    await expect(ram.client.listResources("ram-user", "acct")).rejects.toThrow("no cursor");

    const oss = listWith((req) =>
      req.url.host === "oss-ap-southeast-1.aliyuncs.com"
        ? { raw: bucketsPage("<IsTruncated>true</IsTruncated>") }
        : undefined,
    );
    await expect(oss.client.listResources("oss-bucket", "acct")).rejects.toThrow("no cursor");

    const folder = listWith((req) =>
      req.method === "GET"
        ? { raw: "<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>" }
        : { status: 204 },
    );
    await expect(folder.client.deleteStorageObject!("eu-central-1/b", "f/")).rejects.toThrow(
      "no cursor",
    );
    expect(folder.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });
});

describe("a page that is not a list", () => {
  it("rejects a renamed key on the first page and on a later one", async () => {
    const first = listWith((req) =>
      req.action === "DescribeVpcs"
        ? { body: { Vpcs: { Renamed: [] }, TotalCount: 3 } }
        : undefined,
    );
    await expect(first.client.listResources("vpc", "acct")).rejects.toThrow(NOT_A_LIST);

    const later = listWith((req) => {
      if (req.action !== "DescribeVpcs") return undefined;
      return req.params["PageNumber"] === "1"
        ? { body: { Vpcs: vpcs(50), TotalCount: 60 } }
        : { body: { Vpcs: { Renamed: [] }, TotalCount: 60 } };
    });
    await expect(later.client.listResources("vpc", "acct")).rejects.toThrow(NOT_A_LIST);

    const disks = listWith((req) => {
      if (req.action !== "DescribeDisks") return undefined;
      return req.params["NextToken"]
        ? { body: { Disks: { Renamed: [] } } }
        : { body: { Disks: { Disk: [disk("d-1")] }, NextToken: "t2" } };
    });
    await expect(disks.client.listResources("disk", "acct")).rejects.toThrow(NOT_A_LIST);
  });

  it("rejects an answer with neither a list nor a count", async () => {
    const { client } = listWith((req) =>
      req.action === "DescribeVpcs" ? { body: { RequestId: "r" } } : undefined,
    );
    await expect(client.listResources("vpc", "acct")).rejects.toThrow(NOT_A_LIST);
  });

  it("rejects a list that is not an array", async () => {
    const { client } = listWith((req) =>
      req.action === "DescribeVpcs" ? { body: { Vpcs: { Vpc: {} }, TotalCount: 0 } } : undefined,
    );
    await expect(client.listResources("vpc", "acct")).rejects.toThrow(NOT_A_LIST);
  });

  it("reads a count of zero with no list as empty, and a null list as empty", async () => {
    const zero = listWith((req) =>
      req.action === "DescribeVpcs" ? { body: { TotalCount: 0 } } : undefined,
    );
    expect(await zero.client.listResources("vpc", "acct")).toEqual([]);

    const nil = listWith((req) =>
      req.action === "DescribeDisks" ? { body: { Disks: { Disk: null } } } : undefined,
    );
    expect(await nil.client.listResources("disk", "acct")).toEqual([]);
  });

  it("reads a missing list as empty only on ALB and Function Compute", async () => {
    const { client } = listWith((req) =>
      req.action === "ListLoadBalancers" || req.action === "ListFunctions"
        ? { body: { RequestId: "r" } }
        : undefined,
    );
    expect(await client.listResources("alb", "acct")).toEqual([]);
    expect(await client.listResources("fc-function", "acct")).toEqual([]);

    const wrong = listWith((req) =>
      req.action === "ListFunctions" ? { body: { functions: {} } } : undefined,
    );
    await expect(wrong.client.listResources("fc-function", "acct")).rejects.toThrow(NOT_A_LIST);
  });

  it("reads a missing list as empty only on an answer that is otherwise an empty last page", async () => {
    const zero = listWith((req) =>
      req.action === "ListLoadBalancers" ? { body: { RequestId: "r", TotalCount: 0 } } : undefined,
    );
    expect(await zero.client.listResources("alb", "acct")).toEqual([]);

    const counted = listWith((req) =>
      req.action === "ListLoadBalancers" ? { body: { RequestId: "r", TotalCount: 3 } } : undefined,
    );
    await expect(counted.client.listResources("alb", "acct")).rejects.toThrow(NOT_A_LIST);

    const albMore = listWith((req) =>
      req.action === "ListLoadBalancers" ? { body: { RequestId: "r", NextToken: "t" } } : undefined,
    );
    await expect(albMore.client.listResources("alb", "acct")).rejects.toThrow(NOT_A_LIST);

    const fcMore = listWith((req) =>
      req.action === "ListFunctions" ? { body: { nextToken: "t" } } : undefined,
    );
    await expect(fcMore.client.listResources("fc-function", "acct")).rejects.toThrow(NOT_A_LIST);
  });

  it("rejects a RAM answer with no user list", async () => {
    const { client } = listWith((req) =>
      req.action === "ListUsers" ? { body: { IsTruncated: false } } : undefined,
    );
    await expect(client.listResources("ram-user", "acct")).rejects.toThrow(NOT_A_LIST);
  });

  it("rejects an OSS answer that is not a bucket listing", async () => {
    const { client } = listWith((req) =>
      req.url.host === "oss-ap-southeast-1.aliyuncs.com"
        ? { raw: "<html>gateway</html>" }
        : undefined,
    );
    await expect(client.listResources("oss-bucket", "acct")).rejects.toThrow(NOT_A_LIST);
  });

  it("reads an OSS answer with no buckets as empty", async () => {
    const { client } = listWith((req) =>
      req.url.host === "oss-ap-southeast-1.aliyuncs.com"
        ? { raw: "<ListAllMyBucketsResult><Buckets/></ListAllMyBucketsResult>" }
        : undefined,
    );
    expect(await client.listResources("oss-bucket", "acct")).toEqual([]);
  });

  it("rejects a bill with no data, or items it counted and did not send", async () => {
    const range = { fromDate: "2026-09-01", toDate: "2026-09-01" } as never;
    const noData = listWith((req) =>
      req.action === "DescribeInstanceBill" ? { body: { Success: true } } : undefined,
    );
    await expect(noData.client.fetchCostData("acct", range)).rejects.toThrow(NOT_A_LIST);

    const counted = listWith((req) =>
      req.action === "DescribeInstanceBill"
        ? { body: { Success: true, Data: { Renamed: [], TotalCount: 4 } } }
        : undefined,
    );
    await expect(counted.client.fetchCostData("acct", range)).rejects.toThrow(NOT_A_LIST);

    const quiet = listWith((req) =>
      req.action === "DescribeInstanceBill"
        ? { body: { Success: true, Data: { TotalCount: 0 } } }
        : undefined,
    );
    expect(await quiet.client.fetchCostData("acct", range)).toEqual([]);
  });
});
