import { afterEach, describe, expect, it, vi } from "vitest";
import * as listers from "../resource-listers.js";
import type { ListerContext } from "../resource-listers.js";
import { listAppRegistrations } from "../app-registration.js";

const BUDGET = 1000;
const CONCURRENCY = 5;
const OVER = "has more than Infrawrench reads";

afterEach(() => vi.restoreAllMocks());

/** Every read takes a turn of the event loop, so reads that overlap are seen to. */
function makeCtx(getImpl: (url: string) => unknown) {
  let active = 0;
  const stats = { reads: 0, peak: 0 };
  const get = async (url: string) => {
    stats.reads++;
    active++;
    stats.peak = Math.max(stats.peak, active);
    await new Promise((resolve) => setTimeout(resolve, 0));
    active--;
    const answer = getImpl(url);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const ctx: ListerContext = {
    get: get as ListerContext["get"],
    post: vi.fn() as ListerContext["post"],
    put: vi.fn() as ListerContext["put"],
    del: vi.fn(),
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "2024-01-01T00:00:00Z",
    subscriptionId: "sub1",
  };
  return { ctx, stats };
}

const vms = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `/subscriptions/sub1/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm${i}`,
    name: `vm${i}`,
    properties: { networkProfile: { networkInterfaces: [{ id: `/nic${i}` }] } },
  }));
const NIC = {
  properties: {
    ipConfigurations: [
      { properties: { privateIPAddress: "10.0.0.4", publicIPAddress: { id: "/pips/p" } } },
    ],
  },
};
const answerVms = (list: unknown[]) => (url: string) => {
  if (url.includes("virtualMachines?")) return { value: list };
  if (url.includes("/nic")) return NIC;
  return { properties: { ipAddress: "1.2.3.4" } };
};

describe("listVMs per-row reads", () => {
  it("fills every VM of a subscription inside the budget", async () => {
    const { ctx, stats } = makeCtx(answerVms(vms(100)));
    const rows = await listers.listVMs(ctx, "acct");
    expect(rows.every((r) => r.resolvedOutputs["publicIp"] === "1.2.3.4")).toBe(true);
    expect(stats.reads).toBe(1 + 200);
  });

  it("runs them a few at a time, and keeps the list's order", async () => {
    const { ctx, stats } = makeCtx(answerVms(vms(100)));
    const rows = await listers.listVMs(ctx, "acct");
    expect(stats.peak).toBeLessThanOrEqual(CONCURRENCY);
    expect(stats.peak).toBeGreaterThan(1);
    expect(rows.map((r) => r.displayName)).toEqual(vms(100).map((v) => v.name));
  });

  it("past the budget keeps every row and stops filling them in", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { ctx, stats } = makeCtx(answerVms(vms(2000)));
    const rows = await listers.listVMs(ctx, "acct");
    expect(rows).toHaveLength(2000);
    expect(stats.reads).toBeLessThanOrEqual(BUDGET);
    expect(rows[0]!.resolvedOutputs["publicIp"]).toBe("1.2.3.4");
    expect(rows[1999]!.resolvedOutputs).toEqual({});
    expect(rows[1999]!.fields).not.toHaveProperty("vnetName");
  });

  it("counts the list's own pages against the budget", async () => {
    const next = "https://management.azure.com/next?$skiptoken=1";
    const answer = answerVms(vms(2000));
    const { ctx, stats } = makeCtx((url) => {
      if (url === next) return answer("virtualMachines?");
      if (url.includes("virtualMachines?")) return { value: [], nextLink: next };
      return answer(url);
    });
    await listers.listVMs(ctx, "acct");
    expect(stats.reads).toBeLessThanOrEqual(BUDGET);
  });

  it("starts somewhere else each poll, so no VM goes unfilled for good", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { ctx } = makeCtx(answerVms(vms(2000)));
    const rows = await listers.listVMs(ctx, "acct");
    expect(rows[0]!.resolvedOutputs).toEqual({});
    expect(rows[1000]!.resolvedOutputs["publicIp"]).toBe("1.2.3.4");
  });

  it("stops asking once ARM throttles, which it documents as not processing them", async () => {
    const { ctx, stats } = makeCtx((url) =>
      url.includes("virtualMachines?")
        ? { value: vms(500) }
        : new Error("Azure API 429: Too many requests"),
    );
    const rows = await listers.listVMs(ctx, "acct");
    expect(rows).toHaveLength(500);
    expect(stats.reads).toBeLessThanOrEqual(1 + CONCURRENCY);
  });
});

describe("listSQLDatabases per-server reads", () => {
  const servers = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `/subscriptions/sub1/resourceGroups/rg/providers/Microsoft.Sql/servers/s${i}`,
      name: `s${i}`,
    }));
  const answer = (count: number) => (url: string) =>
    url.includes("/databases?") ? { value: [{ name: "db" }] } : { value: servers(count) };

  it("reads a few at a time, in the list's order", async () => {
    const { ctx, stats } = makeCtx(answer(50));
    const rows = await listers.listSQLDatabases(ctx, "acct");
    expect(rows.map((r) => r.fields["serverName"])).toEqual(servers(50).map((s) => s.name));
    expect(stats.peak).toBeLessThanOrEqual(CONCURRENCY);
    expect(stats.peak).toBeGreaterThan(1);
  });

  it("refuses past the budget, since the databases are the rows", async () => {
    const { ctx, stats } = makeCtx(answer(2000));
    await expect(listers.listSQLDatabases(ctx, "acct")).rejects.toThrow(OVER);
    expect(stats.reads).toBeLessThanOrEqual(BUDGET);
  });

  it("starts no more reads once one has failed the type", async () => {
    const { ctx, stats } = makeCtx((url) =>
      url.includes("/databases?") ? new Error("Azure API 500: boom") : { value: servers(500) },
    );
    await expect(listers.listSQLDatabases(ctx, "acct")).rejects.toThrow("Azure API 500");
    expect(stats.reads).toBeLessThanOrEqual(1 + CONCURRENCY);
  });
});

describe.each([
  ["listManagedRedis", listers.listManagedRedis, /\/databases\?/, "clientProtocol"],
  ["listAIServicesAccounts", listers.listAIServicesAccounts, /\/deployments\?/, "deploymentCount"],
] as const)("%s per-row reads", (_name, list, childUrl, childField) => {
  const parents = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `/subscriptions/sub1/resourceGroups/rg/providers/Microsoft.X/things/p${i}`,
      name: `p${i}`,
    }));
  const answer = (count: number) => (url: string) =>
    childUrl.test(url) ? { value: [] } : { value: parents(count) };

  it("runs them a few at a time", async () => {
    const { ctx, stats } = makeCtx(answer(100));
    const rows = await list(ctx, "acct");
    expect(rows.every((r) => childField in r.fields)).toBe(true);
    expect(stats.peak).toBeLessThanOrEqual(CONCURRENCY);
  });

  it("past the budget keeps every row and stops filling them in", async () => {
    const { ctx, stats } = makeCtx(answer(2000));
    const rows = await list(ctx, "acct");
    expect(rows).toHaveLength(2000);
    expect(stats.reads).toBeLessThanOrEqual(BUDGET);
    expect(rows.filter((r) => !(childField in r.fields))).toHaveLength(2000 - (BUDGET - 1));
  });

  it("stops at the budget on a child list that never ends, and keeps the row", async () => {
    let n = 0;
    const { ctx, stats } = makeCtx((url) =>
      childUrl.test(url) || url.includes("/next?")
        ? { value: [], nextLink: `https://management.azure.com/next?$skiptoken=${n++}` }
        : { value: parents(1) },
    );
    const rows = await list(ctx, "acct");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fields).not.toHaveProperty(childField);
    expect(stats.reads).toBe(BUDGET);
  }, 30_000);

  it("does not swallow a child list's foreign next link", async () => {
    const { ctx } = makeCtx((url) =>
      childUrl.test(url)
        ? { value: [], nextLink: "https://evil.example/next" }
        : { value: parents(1) },
    );
    await expect(list(ctx, "acct")).rejects.toThrow(
      "Refusing to send the account's credentials there",
    );
  });
});

describe("listAppRegistrations service principal lookups", () => {
  function graph(count: number) {
    let active = 0;
    const stats = { lookups: 0, peak: 0 };
    const apps = Array.from({ length: count }, (_, i) => ({
      id: `o${i}`,
      appId: `a${i}`,
      displayName: `A${i}`,
    }));
    const api = (path: string) =>
      path === "/applications"
        ? { top: () => ({ select: () => ({ get: async () => ({ value: apps }) }) }) }
        : {
            filter: () => ({
              select: () => ({
                get: async () => {
                  stats.lookups++;
                  active++;
                  stats.peak = Math.max(stats.peak, active);
                  await new Promise((resolve) => setTimeout(resolve, 0));
                  active--;
                  return { value: [{ id: "sp" }] };
                },
              }),
            }),
          };
    const list = () =>
      listAppRegistrations(
        {
          graphClient: { api } as never,
          makeId: (a, t, e) => `${a}:${t}:${e}`,
          now: () => "2024-01-01T00:00:00Z",
          tenantId: "t1",
        },
        "acct",
      );
    return { list, stats };
  }

  it("runs them a few at a time", async () => {
    const { list, stats } = graph(100);
    const rows = await list();
    expect(rows.every((r) => r.fields["servicePrincipalId"] === "sp")).toBe(true);
    expect(stats.peak).toBeLessThanOrEqual(CONCURRENCY);
    expect(stats.peak).toBeGreaterThan(1);
  });

  it("past the budget keeps every row and stops filling them in", async () => {
    const { list, stats } = graph(2000);
    const rows = await list();
    expect(rows).toHaveLength(2000);
    expect(stats.lookups).toBe(BUDGET - 1);
    expect(rows.filter((r) => !("servicePrincipalId" in r.fields))).toHaveLength(2000 - 999);
  });
});
