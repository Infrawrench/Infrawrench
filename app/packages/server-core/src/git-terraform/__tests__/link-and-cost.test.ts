import { describe, expect, it, vi } from "vitest";
import type { PlanPricingInputs } from "@infrawrench/git-terraform";
import type { TerraformExportCapability } from "@infrawrench/plugin-base";

// Both modules import the database client at load; what is tested here is pure.
vi.mock("../../db/client.js", () => ({ db: {} }));

const { inventoryCandidates, managedRows } = await import("../link");
const { priceTerraformPlan } = await import("../plan-cost");
const { monthlyCostWindow } = await import("../managed");
type InventoryRow = import("../../iac/service").InventoryRow;
type PlanCostDeps = import("../plan-cost").PlanCostDeps;

/** A plugin's export capability, reduced to what linking and pricing read. */
const capability = (
  type: string,
  attributes: (fields: Record<string, unknown>) => Record<string, unknown> = () => ({}),
): TerraformExportCapability =>
  ({
    supportedResourceTypeIds: ["server"],
    mapResource: (resource: {
      displayName: string;
      externalId?: string;
      fields: Record<string, unknown>;
    }) => ({
      resource: {
        type,
        name: resource.displayName,
        importId: resource.externalId ? `import/${resource.externalId}` : undefined,
        attributes: Object.fromEntries(
          Object.entries(attributes(resource.fields)).map(([key, value]) => [
            key,
            { kind: "string", value: String(value) },
          ]),
        ),
      },
    }),
  }) as unknown as TerraformExportCapability;

const row = (over: Partial<InventoryRow> & { id: string }): InventoryRow => ({
  pluginId: "cloud",
  resourceTypeId: "server",
  accountId: "acct-1",
  displayName: over.id,
  externalId: null,
  fieldsJson: {},
  outputsJson: {},
  parentResourceId: null,
  ...over,
});

const capabilities = (byPlugin: Record<string, TerraformExportCapability>) => ({
  capabilityFor: (pluginId: string) => byPlugin[pluginId],
  typeMap: {
    byTerraformType: new Map([["cloud_server", [{ pluginId: "cloud", resourceTypeId: "server" }]]]),
    byResourceType: new Map([["cloud/server", ["cloud_server"]]]),
    underivable: [],
  },
});

/** A state as Terraform writes it (format version 4), with a secret it must never leak. */
const STATE = {
  version: 4,
  terraform_version: "1.15.8",
  serial: 7,
  lineage: "lineage-1",
  resources: [
    {
      mode: "managed",
      type: "cloud_server",
      name: "web",
      provider: 'provider["registry.terraform.io/acme/cloud"]',
      instances: [
        {
          index_key: 0,
          attributes: { id: "srv-1", name: "web-0", root_password: "not-a-real-password" },
        },
        { index_key: 1, attributes: { id: "import/srv-2", name: "web-1" } },
      ],
    },
    {
      module: "module.data",
      mode: "managed",
      type: "cloud_volume",
      name: "disk",
      provider: 'provider["registry.terraform.io/acme/cloud"]',
      instances: [{ attributes: { id: "vol-9", name: "disk" } }],
    },
    {
      mode: "managed",
      type: "other_thing",
      name: "x",
      provider: 'provider["registry.terraform.io/acme/other"]',
      instances: [{ attributes: { id: "shared-id" } }],
    },
    {
      mode: "data",
      type: "cloud_image",
      name: "base",
      provider: 'provider["registry.terraform.io/acme/cloud"]',
      instances: [{ attributes: { id: "img-1" } }],
    },
  ],
};

describe("linking a state to the inventory", () => {
  const caps = capabilities({ cloud: capability("cloud_server") });
  const inventory = [
    row({ id: "acct-1:server:srv-1", externalId: "srv-1" }),
    row({ id: "acct-1:server:srv-2", externalId: "srv-2" }),
    // Synced, and in no state.
    row({ id: "acct-1:server:srv-3", externalId: "srv-3" }),
    // A plugin with no export mapper: matched by identifier alone.
    row({
      id: "acct-2:disk:vol-9",
      pluginId: "storage",
      resourceTypeId: "disk",
      externalId: "vol-9",
    }),
    // Shares an id with a state entry of another type: a typed candidate does not cross types.
    row({ id: "acct-1:server:shared-id", externalId: "shared-id" }),
  ];

  it("reads each resource's Terraform type and import id from its plugin's own mapper", () => {
    const candidates = inventoryCandidates(inventory, caps);
    expect(candidates[0]).toEqual({
      resourceId: "acct-1:server:srv-1",
      terraformType: "cloud_server",
      importId: "import/srv-1",
      externalId: "srv-1",
    });
    expect(candidates[3]).toEqual({
      resourceId: "acct-2:disk:vol-9",
      terraformType: null,
      importId: null,
      externalId: "vol-9",
    });
  });

  it("survives a mapper that throws, falling back to the derived type", () => {
    const throwing = capabilities({
      cloud: {
        ...capability("cloud_server"),
        mapResource: () => {
          throw new Error("boom");
        },
      } as TerraformExportCapability,
    });
    expect(inventoryCandidates([inventory[0]!], throwing)[0]).toMatchObject({
      terraformType: "cloud_server",
      importId: null,
      externalId: "srv-1",
    });
  });

  it("writes one row per managed instance, matched or not, and no value of the state", () => {
    const { rows } = managedRows(STATE, inventoryCandidates(inventory, caps));
    expect(rows.map((r) => [r.address, r.resourceId, r.matchedBy])).toEqual([
      ["cloud_server.web[0]", "acct-1:server:srv-1", "external-id"],
      ["cloud_server.web[1]", "acct-1:server:srv-2", "import-id"],
      ["module.data.cloud_volume.disk", "acct-2:disk:vol-9", "identifier"],
      // Same id, another Terraform type: not the server.
      ["other_thing.x", null, null],
    ]);
    // Data sources are read, not managed.
    expect(rows.some((r) => r.address.startsWith("data."))).toBe(false);
    expect(rows[0]).toMatchObject({
      terraformType: "cloud_server",
      provider: "registry.terraform.io/acme/cloud",
      label: "web-0",
    });
    expect(JSON.stringify(rows)).not.toContain("not-a-real-password");
  });

  it("links nothing for a state it cannot read, rather than failing", () => {
    expect(managedRows({ version: 3 }, []).rows).toEqual([]);
    expect(managedRows(null, []).rows).toEqual([]);
  });
});

describe("pricing a plan", () => {
  const caps = capabilities({
    cloud: capability("cloud_server", (fields) => ({
      size: fields["size"],
      region: fields["region"],
    })),
  });
  const PRICES: Record<string, number> = { small: 10, large: 40 };
  const deps = (over: Partial<PlanCostDeps> = {}): PlanCostDeps => ({
    capabilities: caps,
    estimate: async (_organizationId, input) => {
      const amount = PRICES[input.fields?.["size"] ?? ""];
      return amount === undefined
        ? null
        : {
            monthlyAmount: amount,
            currency: "USD",
            lineItems: [{ label: "Server", monthlyAmount: amount }],
          };
    },
    ...over,
  });
  const accounts = [{ id: "acct-1", pluginId: "cloud" }];
  const inputs = (changes: PlanPricingInputs["changes"], omitted = 0): PlanPricingInputs => ({
    changes,
    omitted,
  });

  it("prices creates, resizes and deletes from the plan's own attributes", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const delta = await priceTerraformPlan(
      "org-1",
      accounts,
      inputs([
        {
          address: "cloud_server.a",
          type: "cloud_server",
          action: "create",
          before: null,
          after: { size: "small", region: "eu" },
        },
        {
          address: "cloud_server.b",
          type: "cloud_server",
          action: "update",
          before: { size: "small" },
          after: { size: "large" },
        },
        {
          address: "cloud_server.c",
          type: "cloud_server",
          action: "delete",
          before: { size: "large" },
          after: null,
        },
      ]),
      deps({
        estimate: async (organizationId, input) => {
          expect(organizationId).toBe("org-1");
          expect(input).toMatchObject({ accountId: "acct-1", resourceTypeId: "server" });
          seen.push(input.fields);
          return deps().estimate(organizationId, input);
        },
      }),
    );
    // +10, +30, -40.
    expect(delta).toEqual({
      monthlyDelta: 0,
      currency: "USD",
      partial: false,
      pricedChanges: 3,
      unpricedChanges: 0,
    });
    // Attributes became the create form's fields through the plugin's own mapper.
    expect(seen).toContainEqual({ size: "small", region: "eu" });
  });

  it("counts what it cannot price, and never makes the total smaller for it", async () => {
    const delta = await priceTerraformPlan(
      "org-1",
      accounts,
      inputs(
        [
          {
            address: "cloud_server.a",
            type: "cloud_server",
            action: "create",
            before: null,
            after: { size: "large" },
          },
          // A size the provider publishes no price for.
          {
            address: "cloud_server.b",
            type: "cloud_server",
            action: "create",
            before: null,
            after: { size: "huge" },
          },
          // A type no plugin maps.
          { address: "random_id.x", type: "random_id", action: "create", before: null, after: {} },
        ],
        2,
      ),
      deps(),
    );
    expect(delta).toEqual({
      monthlyDelta: 40,
      currency: "USD",
      partial: true,
      pricedChanges: 1,
      unpricedChanges: 4,
    });
  });

  it("prices nothing through an account the workspace does not link: null, not zero", async () => {
    const estimate = vi.fn(deps().estimate);
    const delta = await priceTerraformPlan(
      "org-1",
      [{ id: "acct-9", pluginId: "another" }],
      inputs([
        {
          address: "cloud_server.a",
          type: "cloud_server",
          action: "create",
          before: null,
          after: { size: "small" },
        },
      ]),
      deps({ estimate }),
    );
    expect(estimate).not.toHaveBeenCalled();
    expect(delta).toEqual({
      monthlyDelta: null,
      currency: null,
      partial: true,
      pricedChanges: 0,
      unpricedChanges: 1,
    });
  });

  it("treats a pricing API that throws as unpriced", async () => {
    const delta = await priceTerraformPlan(
      "org-1",
      accounts,
      inputs([
        {
          address: "cloud_server.a",
          type: "cloud_server",
          action: "create",
          before: null,
          after: { size: "small" },
        },
      ]),
      deps({
        estimate: async () => {
          throw new Error("pricing is down");
        },
      }),
    );
    expect(delta).toMatchObject({ monthlyDelta: null, partial: true, unpricedChanges: 1 });
  });
});

describe("the monthly cost window", () => {
  it("is the thirty days up to yesterday", () => {
    expect(monthlyCostWindow(Date.UTC(2026, 10, 26, 12))).toEqual({
      from: "2026-10-27",
      to: "2026-11-25",
    });
  });
});
