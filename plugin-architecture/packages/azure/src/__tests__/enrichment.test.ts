import { describe, expect, it, vi } from "vitest";
import * as listers from "../resource-listers.js";
import type { ListerContext } from "../resource-listers.js";
import { listAppRegistrations } from "../app-registration.js";

function makeCtx(getImpl: (url: string) => unknown) {
  const get = vi.fn(async (url: string) => {
    const answer = getImpl(url);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const ctx: ListerContext = {
    get: get as ListerContext["get"],
    post: vi.fn() as ListerContext["post"],
    put: vi.fn() as ListerContext["put"],
    del: vi.fn(),
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "2024-01-01T00:00:00Z",
    subscriptionId: "sub1",
  };
  return { ctx, get };
}

const BOOM = "Azure API 500: boom";
const VM_NETWORK_FIELDS = [
  "vnetName",
  "subnetName",
  "networkResourceGroup",
  "networkSecurityGroup",
  "publicIpName",
];
const vm = (name: string, nicId?: string) => ({
  id: `/subscriptions/sub1/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/${name}`,
  name,
  properties: nicId ? { networkProfile: { networkInterfaces: [{ id: nicId }] } } : {},
});
const nic = (publicIpId?: string) => ({
  properties: {
    ipConfigurations: [
      {
        properties: {
          privateIPAddress: "10.0.0.4",
          ...(publicIpId ? { publicIPAddress: { id: publicIpId } } : {}),
        },
      },
    ],
  },
});

describe("listVMs when an enrichment read fails", () => {
  it("leaves the network fields and outputs out when the NIC read fails", async () => {
    const { ctx } = makeCtx((url) =>
      url.includes("virtualMachines?") ? { value: [vm("a", "/nic1")] } : new Error(BOOM),
    );
    const [row] = await listers.listVMs(ctx, "acct");
    expect(row!.displayName).toBe("a");
    expect(row!.resolvedOutputs).toEqual({});
    for (const key of VM_NETWORK_FIELDS) expect(row!.fields).not.toHaveProperty(key);
  });

  it("leaves only the address out when the public IP read fails", async () => {
    const { ctx } = makeCtx((url) => {
      if (url.includes("virtualMachines?")) return { value: [vm("a", "/nic1")] };
      if (url.includes("/nic1")) return nic("/pip/pip1");
      return new Error(BOOM);
    });
    const [row] = await listers.listVMs(ctx, "acct");
    expect(row!.resolvedOutputs).toEqual({ privateIp: "10.0.0.4" });
    expect(row!.fields["publicIpName"]).toBe("pip1");
  });

  it("still clears an address the VM really no longer has", async () => {
    const { ctx } = makeCtx((url) =>
      url.includes("virtualMachines?") ? { value: [vm("a", "/nic1")] } : nic(),
    );
    const [row] = await listers.listVMs(ctx, "acct");
    expect(row!.resolvedOutputs).toEqual({ privateIp: "10.0.0.4", publicIp: "", fqdn: "" });
    expect(row!.fields["publicIpName"]).toBe("");
  });

  it("still clears the network of a VM with no NIC", async () => {
    const { ctx } = makeCtx(() => ({ value: [vm("a")] }));
    const [row] = await listers.listVMs(ctx, "acct");
    expect(row!.resolvedOutputs).toEqual({ publicIp: "", privateIp: "", fqdn: "" });
    expect(row!.fields["vnetName"]).toBe("");
  });
});

describe("listManagedRedis when the database read fails", () => {
  const CLUSTER = {
    id: "/subscriptions/sub1/resourceGroups/rg/providers/Microsoft.Cache/redisEnterprise/c",
    name: "c",
    properties: { hostName: "c.redis.azure.net" },
  };
  const DB_FIELDS = [
    "clientProtocol",
    "clusteringPolicy",
    "evictionPolicy",
    "modules",
    "persistence",
    "accessKeysAuthentication",
    "redisVersion",
  ];

  it("leaves what the database says out, and does not guess the port", async () => {
    const { ctx } = makeCtx((url) =>
      url.includes("/databases?") ? new Error(BOOM) : { value: [CLUSTER] },
    );
    const [row] = await listers.listManagedRedis(ctx, "acct");
    expect(row!.resolvedOutputs["hostName"]).toBe("c.redis.azure.net");
    expect(row!.resolvedOutputs).not.toHaveProperty("port");
    for (const key of DB_FIELDS) expect(row!.fields).not.toHaveProperty(key);
  });

  it("keeps the redis version the cluster itself reports", async () => {
    const { ctx } = makeCtx((url) =>
      url.includes("/databases?")
        ? new Error(BOOM)
        : { value: [{ ...CLUSTER, properties: { ...CLUSTER.properties, redisVersion: "7.2" } }] },
    );
    const [row] = await listers.listManagedRedis(ctx, "acct");
    expect(row!.fields["redisVersion"]).toBe("7.2");
  });

  it("still reports a read that found no database", async () => {
    const { ctx } = makeCtx((url) =>
      url.includes("/databases?") ? { value: [] } : { value: [CLUSTER] },
    );
    const [row] = await listers.listManagedRedis(ctx, "acct");
    expect(row!.resolvedOutputs["port"]).toBe("10000");
    expect(row!.fields["clientProtocol"]).toBe("");
  });
});

describe("listAIServicesAccounts when the deployments read fails", () => {
  const ACCOUNT = {
    id: "/subscriptions/sub1/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/a",
    name: "a",
  };

  it.each([
    ["a 500", BOOM],
    ["a throttle", "Azure API 429: slow down"],
    ["an expired credential", "Azure API 401: expired"],
    ["a dropped connection", "fetch failed"],
  ])("leaves the count out on %s rather than saying zero", async (_what, message) => {
    const { ctx } = makeCtx((url) =>
      url.includes("/deployments?") ? new Error(message) : { value: [ACCOUNT] },
    );
    const [row] = await listers.listAIServicesAccounts(ctx, "acct");
    expect(row!.fields).not.toHaveProperty("deploymentCount");
    expect(row!.fields).not.toHaveProperty("deployments");
  });

  it("reads a kind that refuses deployments as having none", async () => {
    const { ctx } = makeCtx((url) =>
      url.includes("/deployments?")
        ? new Error("Azure API 400: not for Speech")
        : { value: [ACCOUNT] },
    );
    const [row] = await listers.listAIServicesAccounts(ctx, "acct");
    expect(row!.fields["deploymentCount"]).toBe(0);
    expect(row!.fields["deployments"]).toBe("");
  });
});

describe("listAppRegistrations when a service principal lookup fails", () => {
  const graph = (lookup: () => Promise<unknown>) => ({
    api: (path: string) =>
      path === "/applications"
        ? {
            top: () => ({
              select: () => ({
                get: async () => ({ value: [{ id: "o", appId: "a", displayName: "A" }] }),
              }),
            }),
          }
        : { filter: () => ({ select: () => ({ get: lookup }) }) },
  });
  const list = (lookup: () => Promise<unknown>) =>
    listAppRegistrations(
      {
        graphClient: graph(lookup) as never,
        makeId: (a, t, e) => `${a}:${t}:${e}`,
        now: () => "2024-01-01T00:00:00Z",
        tenantId: "t1",
      },
      "acct",
    );

  it("leaves the id out", async () => {
    const [row] = await list(() => Promise.reject(new Error("sp boom")));
    expect(row!.displayName).toBe("A");
    expect(row!.fields).not.toHaveProperty("servicePrincipalId");
  });

  it("still clears the id of an app with no service principal", async () => {
    const [row] = await list(async () => ({ value: [] }));
    expect(row!.fields["servicePrincipalId"]).toBe("");
  });
});
