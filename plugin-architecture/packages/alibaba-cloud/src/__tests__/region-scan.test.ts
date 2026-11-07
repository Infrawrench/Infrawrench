import { describe, expect, it } from "vitest";
import { ALI_REGIONS } from "../regions.js";
import { makeClient, type Recorded, type Reply } from "./helpers.js";

const NO_REGION_LIST = { regions: "" };
const NO_VPCS: Reply = { body: { Vpcs: { Vpc: [] }, TotalCount: 0 } };
const CALLER: Reply = { body: { AccountId: "5123" } };

const scanned = (calls: Recorded[]) =>
  calls.filter((c) => c.action === "DescribeVpcs").map((c) => c.params["RegionId"]);

describe("the regions a list scans", () => {
  it("includes a sold-out region, which still holds what runs there", async () => {
    const { client, calls } = makeClient((req) => {
      if (req.action === "DescribeRegions") {
        return {
          body: {
            Regions: {
              Region: [
                { RegionId: "ap-southeast-1", Status: "available" },
                { RegionId: "eu-central-1", Status: "soldOut" },
              ],
            },
          },
        };
      }
      return req.action === "DescribeVpcs" ? NO_VPCS : undefined;
    }, NO_REGION_LIST);
    await client.listResources("vpc", "acct");
    expect(scanned(calls).sort()).toEqual(["ap-southeast-1", "eu-central-1"]);
  });

  it("falls back to the public list when DescribeRegions is refused", async () => {
    const { client, calls } = makeClient((req) => {
      if (req.action === "DescribeRegions") {
        return { status: 403, body: { Code: "Unauthorized.EmptyRegion", Message: "no" } };
      }
      return req.action === "DescribeVpcs" ? NO_VPCS : undefined;
    }, NO_REGION_LIST);
    await client.listResources("vpc", "acct");
    expect(scanned(calls)).toContain("eu-central-1");
    expect(scanned(calls).length).toBeGreaterThan(1);
    expect(ALI_REGIONS.map((r) => r.id)).toEqual(expect.arrayContaining(scanned(calls)));
  });

  it("fails on any other DescribeRegions failure", async () => {
    const { client } = makeClient(
      () => ({ status: 500, body: { Code: "InternalError", Message: "boom" } }),
      NO_REGION_LIST,
    );
    await expect(client.listResources("vpc", "acct")).rejects.toThrow("InternalError");
  });

  it("refuses an answer with no region list rather than scan one region", async () => {
    const { client } = makeClient(
      (req) => (req.action === "DescribeRegions" ? { body: { RequestId: "r" } } : NO_VPCS),
      NO_REGION_LIST,
    );
    await expect(client.listResources("vpc", "acct")).rejects.toThrow("is not a list");
  });

  it("does not write a failed region read over the account row", async () => {
    const { client } = makeClient((req) => {
      if (req.action === "GetCallerIdentity") return CALLER;
      return { status: 500, body: { Code: "InternalError", Message: "boom" } };
    }, NO_REGION_LIST);
    await expect(client.listResources("account", "acct")).rejects.toThrow("InternalError");
  });
});
