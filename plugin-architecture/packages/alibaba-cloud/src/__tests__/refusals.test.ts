import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AliApiError, isPermissionGap } from "../api.js";
import { makeClient, type Reply } from "./helpers.js";

const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");
const unread = vi.fn();
const WHOLE_TYPE = { idPrefixes: [""] };

const REFUSED: Reply = { status: 403, body: { Code: "Forbidden.RAM", Message: "no" } };
const NO_REGION: Reply = { status: 400, body: { Code: "InvalidRegionId", Message: "no" } };
const OSS_REFUSED: Reply = { status: 403, raw: "<Error><Code>AccessDenied</Code></Error>" };

beforeEach(() => {
  unread.mockClear();
  Reflect.set(globalThis, UNREAD_HOOK, unread);
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, UNREAD_HOOK);
});

describe("a credential refused for a whole type", () => {
  it("keeps the rows quietly when every region refuses", async () => {
    const { client } = makeClient(() => REFUSED);
    expect(await client.listResources("vpc", "acct")).toEqual([]);
    expect(unread).toHaveBeenCalledWith(WHOLE_TYPE);
  });

  it("still keeps them when some regions refuse and the rest are not available", async () => {
    const { client } = makeClient((req) =>
      req.params["RegionId"] === "eu-central-1" ? NO_REGION : REFUSED,
    );
    expect(await client.listResources("vpc", "acct")).toEqual([]);
    expect(unread).toHaveBeenCalledWith(WHOLE_TYPE);
  });

  it("does not when a region answered", async () => {
    const { client } = makeClient((req) =>
      req.params["RegionId"] === "eu-central-1"
        ? REFUSED
        : { body: { Vpcs: { Vpc: [] }, TotalCount: 0 } },
    );
    expect(await client.listResources("vpc", "acct")).toEqual([]);
    expect(unread).not.toHaveBeenCalled();
  });

  it("does not when no region refused", async () => {
    const { client } = makeClient(() => NO_REGION);
    expect(await client.listResources("vpc", "acct")).toEqual([]);
    expect(unread).not.toHaveBeenCalled();
  });

  it("throws where the host keeps no track, so the refusal shows", async () => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    const { client } = makeClient((req) =>
      req.params["RegionId"] === "eu-central-1" ? NO_REGION : REFUSED,
    );
    await expect(client.listResources("vpc", "acct")).rejects.toThrow("Forbidden.RAM");
  });

  it.each([
    ["oss-bucket", OSS_REFUSED],
    ["dns-domain", REFUSED],
    ["dns-record", REFUSED],
    ["ram-user", REFUSED],
  ])("keeps %s rows quietly", async (type, reply) => {
    const { client } = makeClient(() => reply);
    expect(await client.listResources(type, "acct")).toEqual([]);
    expect(unread).toHaveBeenCalledWith(WHOLE_TYPE);

    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    await expect(makeClient(() => reply).client.listResources(type, "acct")).rejects.toThrow("403");
  });

  it("does not hide a bad credential that OSS answers with a 403", async () => {
    for (const code of ["InvalidAccessKeyId", "SignatureDoesNotMatch", "RequestTimeTooSkewed"]) {
      const { client } = makeClient(() => ({
        status: 403,
        raw: `<Error><Code>${code}</Code></Error>`,
      }));
      await expect(client.listResources("oss-bucket", "acct")).rejects.toThrow(code);
    }
    expect(unread).not.toHaveBeenCalled();
  });

  it("does not hide a disabled key, in any region", async () => {
    const { client } = makeClient(() => ({
      status: 403,
      body: { Code: "Forbidden.AccessKeyDisabled", Message: "no" },
    }));
    await expect(client.listResources("vpc", "acct")).rejects.toThrow("AccessKeyDisabled");
    expect(unread).not.toHaveBeenCalled();
  });

  it("does not read a credential problem or a throttle as a permission gap", () => {
    const gap = (status: number, code: string) =>
      isPermissionGap(new AliApiError(status, code, "", "X"));
    expect(gap(403, "Forbidden.RAM")).toBe(true);
    expect(gap(403, "Unauthorized.EmptyRegion")).toBe(true);
    expect(gap(403, "AccessDenied")).toBe(true);
    expect(gap(400, "NoPermission")).toBe(true);
    expect(gap(401, "Unauthorized")).toBe(false);
    expect(gap(403, "Throttling.User")).toBe(false);
    expect(gap(403, "InvalidAccessKeyId")).toBe(false);
  });
});

describe("a refusal on one ACK cluster", () => {
  const route = (req: { url: URL; action: string }): Reply | undefined => {
    if (req.action === "DescribeClustersV1") {
      return {
        body: {
          clusters: [{ cluster_id: "c-a" }, { cluster_id: "c-b" }],
          page_info: { total_count: 2 },
        },
      };
    }
    if (req.action !== "DescribeClusterNodePools") return undefined;
    if (req.url.pathname.includes("c-a")) return REFUSED;
    return { body: { nodepools: [{ nodepool_info: { nodepool_id: "np-1", name: "np" } }] } };
  };

  it("names that cluster as unread instead of pruning its pools", async () => {
    const { client } = makeClient(route, { regions: "ap-southeast-1" });
    const pools = await client.listResources("ack-node-pool", "acct");
    expect(pools.map((p) => p.externalId)).toEqual(["ap-southeast-1/c-b/np-1"]);
    expect(unread).toHaveBeenCalledWith({
      parentResourceIds: ["acct:ack-cluster:ap-southeast-1/c-a"],
    });
  });

  it("does not stop the other clusters where the host keeps no track", async () => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    const { client } = makeClient(route, { regions: "ap-southeast-1" });
    expect(await client.listResources("ack-node-pool", "acct")).toHaveLength(1);
  });
});
