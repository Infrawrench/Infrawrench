import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { AzureClient } from "../client.js";
import * as auth from "../auth.js";

const creds = {
  tenantId: "t1",
  clientId: "c1",
  clientSecret: "s1",
  subscriptionId: "sub1",
};

function jsonResponse(body: unknown, init: Partial<Response> = {}): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null } as unknown as Headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
    ...init,
  } as unknown as Response;
}

describe("AzureClient construction", () => {
  it("throws when required credentials are missing", () => {
    expect(() => new AzureClient({ tenantId: "t" })).toThrow(/missing tenantId/);
    expect(() => new AzureClient({})).toThrow();
  });

  it("constructs with all required credentials", () => {
    expect(() => new AzureClient(creds)).not.toThrow();
  });
});

describe("AzureClient token + HTTP helpers", () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let tokenSpy: MockInstance<typeof auth.fetchAccessToken>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    tokenSpy = vi.spyOn(auth, "fetchAccessToken").mockResolvedValue("arm-tok");
  });
  afterEach(() => vi.restoreAllMocks());

  it("caches the ARM token across calls (single fetchAccessToken)", async () => {
    const client = new AzureClient(creds);
    fetchSpy.mockResolvedValue(jsonResponse({ value: [] }));
    await client.listResources("azure-resource-group", "acct");
    await client.listResources("azure-resource-group", "acct");
    expect(tokenSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(((init as RequestInit).headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer arm-tok",
    );
  });

  it("get() throws with status + body on a non-ok response", async () => {
    const client = new AzureClient(creds);
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "forbidden",
    } as unknown as Response);
    await expect(client.listResources("azure-vnet", "acct")).rejects.toThrow(
      /Azure API 403: forbidden/,
    );
  });

  it("listResources dispatches to the matching lister and shapes ResourceInstances", async () => {
    const client = new AzureClient(creds);
    fetchSpy.mockResolvedValue(
      jsonResponse({ value: [{ name: "rg-a", location: "eastus", properties: {} }] }),
    );
    const out = await client.listResources("azure-resource-group", "acct");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      resourceTypeId: "azure-resource-group",
      pluginId: "azure",
      accountId: "acct",
      displayName: "rg-a",
      externalId: "rg-a",
    });
    expect(out[0]!.id).toBe("acct:azure-resource-group:rg-a");
  });

  it("listResources throws on an unknown type", async () => {
    const client = new AzureClient(creds);
    await expect(client.listResources("azure-nope", "acct")).rejects.toThrow(
      /unknown resource type "azure-nope"/,
    );
  });

  it("getResource finds a listed resource by id, else throws", async () => {
    const client = new AzureClient(creds);
    fetchSpy.mockResolvedValue(jsonResponse({ value: [{ name: "rg-a", location: "eastus" }] }));
    const found = await client.getResource(
      "azure-resource-group",
      "acct:azure-resource-group:rg-a",
      "acct",
    );
    expect(found.displayName).toBe("rg-a");
    await expect(
      client.getResource("azure-resource-group", "acct:azure-resource-group:missing", "acct"),
    ).rejects.toThrow(/not found/);
  });

  it("renderDetail / renderSidebarItem delegate to renderers", () => {
    const client = new AzureClient(creds);
    const resource = {
      id: "acct:azure-vm:rg/vm1",
      pluginId: "azure",
      resourceTypeId: "azure-vm",
      accountId: "acct",
      displayName: "vm1",
      fields: { provisioningState: "Succeeded", location: "eastus" },
      resolvedOutputs: {},
      secretStates: [],
      externalId: "rg/vm1",
      createdAt: "now",
      updatedAt: "now",
    };
    const detail = client.renderDetail(resource as never);
    expect(detail.title).toBe("vm1");
    const sidebar = client.renderSidebarItem(resource as never);
    expect(sidebar.label).toBe("vm1");
  });

  it("fetchDashboardStats resolves the resource then builds stats", async () => {
    const client = new AzureClient(creds);
    fetchSpy.mockResolvedValue(
      jsonResponse({
        value: [
          { name: "rg-a", location: "eastus", properties: { provisioningState: "Succeeded" } },
        ],
      }),
    );
    const stats = await client.fetchDashboardStats(
      "azure-resource-group",
      "acct:azure-resource-group:rg-a",
      "acct",
    );
    expect(Array.isArray(stats)).toBe(true);
  });

  it("publishMessage throws for unsupported types", async () => {
    const client = new AzureClient(creds);
    // publishMessage resolves the resource first, then rejects unsupported types;
    // stub getResource so the test targets the "not supported" branch directly.
    vi.spyOn(client, "getResource").mockResolvedValue({
      id: "acct:azure-vm:rg/vm",
      resourceTypeId: "azure-vm",
    } as never);
    await expect(
      client.publishMessage("azure-vm", "acct:azure-vm:rg/vm", "acct", {
        body: "{}",
        extras: {},
      } as never),
    ).rejects.toThrow(/publishMessage not supported/);
  });
});

describe("AzureClient pricing", () => {
  beforeEach(() => {
    vi.spyOn(auth, "fetchAccessToken").mockResolvedValue("arm-tok");
  });
  afterEach(() => vi.restoreAllMocks());

  it("getCreateSizePricing returns {} for types without size pricing", async () => {
    const client = new AzureClient(creds);
    const out = await client.getCreateSizePricing("azure-storage-account", {
      sizes: [{ id: "x" }],
    } as never);
    expect(out).toEqual({});
  });

  it("getCreateSizePricing fetches + caches region rates for supported types", async () => {
    const client = new AzureClient(creds);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ Items: [] }));
    const out = await client.getCreateSizePricing("azure-vm", {
      regionId: "eastus",
      sizes: [{ id: "Standard_B1s" }],
    } as never);
    expect(out).toEqual({});
    const callsAfterFirst = fetchSpy.mock.calls.length;
    // Second call for the same region should hit the cache (no new fetches).
    await client.getCreateSizePricing("azure-vm", {
      regionId: "eastus",
      sizes: [{ id: "Standard_B1s" }],
    } as never);
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it("getCreateCostEstimate uses region rates (defaults region to eastus)", async () => {
    const client = new AzureClient(creds);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ Items: [] }));
    const est = await client.getCreateCostEstimate("azure-vm", { size: "unknown" });
    expect(est).toBeNull();
  });
});
