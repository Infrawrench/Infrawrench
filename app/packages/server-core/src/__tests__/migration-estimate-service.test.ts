import { describe, expect, it } from "vitest";
import {
  f,
  rt,
  tf,
  type CreateResourceConfig,
  type HostPlugin,
  type PriceCatalogDeclaration,
  type ResourceTypeDefinition,
  type TerraformExportCapability,
} from "@infrawrench/plugin-base";
import type { MigrationEstimateInput, PriceCatalogRow } from "@infrawrench/client-core";
import {
  createMigrationEstimateService,
  MigrationEstimateInputError,
  MigrationEstimateSourceNotFoundError,
  type MigrationEstimateDeps,
  type MigrationSourceResource,
} from "../migration-estimate/service";

const catalogDecl: PriceCatalogDeclaration = {
  requiresCredentials: false,
  source: { name: "Fake prices", url: "https://example.invalid/prices" },
  refreshHours: 1,
  services: [{ id: "vm", label: "VMs", family: "compute" }],
  regions: [
    { id: "na-1", label: "North one", area: "north-america" },
    { id: "eu-1", label: "Europe one", area: "europe" },
  ],
};

const vmType = (id: string): ResourceTypeDefinition =>
  rt({
    name: "Server",
    id,
    description: "A server",
    equivalence: "vm",
    supportsCreate: true,
    fields: [
      f("size", "Size", { sizing: "instance-type" }),
      f("region", "Region", { sizing: "region" }),
    ],
  });

const bucketType = rt({
  name: "Bucket",
  id: "bucket",
  description: "A bucket",
  equivalence: "object-storage",
  fields: [f("region", "Region", { sizing: "region" })],
});

const plainType = rt({ name: "Firewall", id: "firewall", description: "A firewall", fields: [] });

const clusterType = rt({
  name: "Cluster",
  id: "cluster",
  description: "A cluster",
  equivalence: "kubernetes-cluster",
  fields: [
    f("nodeSize", "Node size", { sizing: "instance-type" }),
    f("nodes", "Nodes", { kind: "number", sizing: "node-count" }),
    f("region", "Region", { sizing: "region" }),
  ],
});

const poolType = rt({
  name: "Pool",
  id: "pool",
  description: "A pool",
  equivalence: "kubernetes-node-pool",
  fields: [
    f("size", "Size", { sizing: "instance-type" }),
    f("count", "Count", { kind: "number", sizing: "node-count" }),
  ],
});

function plugin(
  id: string,
  types: ResourceTypeDefinition[],
  opts: { catalog?: boolean; terraform?: TerraformExportCapability } = {},
): HostPlugin {
  return {
    manifest: {
      id,
      displayName: id.toUpperCase(),
      ...(opts.catalog ? { priceCatalog: catalogDecl } : {}),
    } as HostPlugin["manifest"],
    resourceTypes: types,
    testCredentials: {},
    createClient: () => {
      throw new Error("not used");
    },
    ...(opts.terraform ? { terraformExport: opts.terraform } : {}),
  } as unknown as HostPlugin;
}

function row(
  pluginId: string,
  sku: string,
  vcpus: number,
  memoryGb: number,
  monthly: number,
  region: string,
  currency = "USD",
): PriceCatalogRow {
  return {
    pluginId,
    pluginName: pluginId.toUpperCase(),
    serviceId: "vm",
    serviceLabel: "VMs",
    sku,
    name: sku,
    family: "compute",
    series: null,
    specs: { vcpus, memoryGb },
    region,
    regionLabel: region,
    price: { region, rateType: "on-demand", unit: "month", amount: monthly, currency },
    monthlyAmount: monthly,
    comparable: { amount: monthly, currency },
    otherPrices: [],
    estimate: null,
  };
}

function resource(
  id: string,
  pluginId: string,
  resourceTypeId: string,
  fields: Record<string, unknown>,
  extra: Partial<MigrationSourceResource> = {},
): MigrationSourceResource {
  return {
    id,
    pluginId,
    resourceTypeId,
    accountId: `acct-${pluginId}`,
    displayName: id,
    externalId: `ext-${id}`,
    parentResourceId: null,
    fields,
    ...extra,
  };
}

const terraformCapability: TerraformExportCapability = {
  provider: { name: "beta", source: "example/beta", version: "~> 1.0" },
  providerConfig: { token: tf.ref("var.beta_token") },
  variables: [{ name: "beta_token", sensitive: true }],
  supportedResourceTypeIds: ["server"],
  mapResource: (r) => ({
    resource: {
      type: "beta_server",
      name: r.displayName,
      attributes: {
        size: tf.str(String(r.fields["size"] ?? "")),
        region: tf.str(String(r.fields["region"] ?? "")),
      },
    },
  }),
};

function deps(
  plugins: HostPlugin[],
  resources: MigrationSourceResource[],
  overrides: Partial<MigrationEstimateDeps> = {},
): MigrationEstimateDeps {
  const catalogs: Record<string, PriceCatalogRow[]> = {
    alpha: [row("alpha", "a.large", 4, 16, 100, "na-1"), row("alpha", "a.small", 2, 4, 40, "na-1")],
    beta: [
      row("beta", "b.tiny", 1, 2, 5, "na-1"),
      row("beta", "b.medium", 4, 16, 30, "na-1"),
      row("beta", "b.big", 8, 32, 70, "na-1"),
      row("beta", "b.medium-eu", 4, 16, 25, "eu-1"),
    ],
  };
  return {
    listPlugins: async () => plugins,
    loadService: async (_org, serviceId) =>
      serviceId === "svc" ? { name: "Checkout", resourceIds: resources.map((r) => r.id) } : null,
    loadResources: async (_org, ids) => resources.filter((r) => ids.includes(r.id)),
    loadSpend: async () => new Map([["acct-alpha ext-vm1", [{ amount: 120, currency: "USD" }]]]),
    estimateExisting: async () => null,
    catalogRows: async (_org, pluginId, region) => {
      const all = catalogs[pluginId] ?? [];
      const picked = region ?? "na-1";
      const rows = all.filter((r) => r.region === picked);
      return { state: "ready", region: picked, rows: rows.length > 0 ? rows : all };
    },
    listAccountIds: async () => [],
    createConfig: async () => null,
    sizePricing: async () => null,
    estimateTarget: async () => null,
    loadConverter: async () => ({
      displayCurrency: null,
      convert: (amount, currency) => ({ amount, currency }),
    }),
    now: () => Date.parse("2026-11-18T00:00:00Z"),
    ...overrides,
  };
}

const input = (overrides: Partial<MigrationEstimateInput> = {}): MigrationEstimateInput => ({
  name: "Checkout to Beta",
  source: { kind: "service", serviceId: "svc" },
  targetPluginId: "beta",
  targetRegion: null,
  overrides: {},
  ...overrides,
});

describe("migration estimate service", () => {
  const alpha = plugin("alpha", [vmType("instance"), bucketType, plainType], { catalog: true });
  const beta = plugin("beta", [vmType("server")], {
    catalog: true,
    terraform: terraformCapability,
  });

  it("matches a VM to the cheapest target size meeting its specs and prices both sides", async () => {
    const service = createMigrationEstimateService(
      deps(
        [alpha, beta],
        [resource("vm1", "alpha", "instance", { size: "a.large", region: "na-1" })],
      ),
    );
    const result = await service.compute("org", input());
    expect(result.source).toEqual({ kind: "service", label: "Checkout", resourceCount: 1 });
    const [vm] = result.rows;
    expect(vm!.specs).toMatchObject({ vcpus: 4, memoryGb: 16, count: 1 });
    expect(vm!.current).toEqual({
      amount: 121.67,
      currency: "USD",
      basis: "billed",
      partial: false,
    });
    expect(vm!.target).toMatchObject({
      resourceTypeId: "server",
      sizeId: "b.medium",
      region: "na-1",
      cost: { amount: 30, currency: "USD", basis: "list-price" },
      overridden: false,
    });
    expect(vm!.candidates[0]).toMatchObject({ id: "b.medium", meetsSpec: true });
    expect(vm!.candidates.find((c) => c.id === "b.tiny")?.meetsSpec).toBe(false);
    expect(result.region).toMatchObject({ region: "na-1", choice: "nearest", crossesArea: false });
    expect(result.totals.comparable).toEqual({
      currency: "USD",
      current: 121.67,
      target: 30,
      pairedDelta: -91.67,
      pairedRows: 1,
    });
    expect(result.terraform).toBe(true);
  });

  it("lists resources with no equivalent apart, with the reason", async () => {
    const service = createMigrationEstimateService(
      deps(
        [alpha, beta],
        [
          resource("fw", "alpha", "firewall", {}),
          resource("b1", "alpha", "bucket", { region: "na-1" }),
        ],
      ),
    );
    const result = await service.compute("org", input());
    expect(result.rows).toEqual([]);
    expect(result.unmatched.map((u) => [u.resourceId, u.reason])).toEqual([
      ["fw", "no-category"],
      ["b1", "no-target-type"],
    ]);
    expect(result.totals.currentUnknown).toBe(0);
  });

  it("uses an override size and says so", async () => {
    const service = createMigrationEstimateService(
      deps(
        [alpha, beta],
        [resource("vm1", "alpha", "instance", { size: "a.large", region: "na-1" })],
      ),
    );
    const result = await service.compute("org", input({ overrides: { vm1: { sizeId: "b.big" } } }));
    expect(result.rows[0]!.target).toMatchObject({ sizeId: "b.big", overridden: true });
    expect(result.rows[0]!.target.cost?.amount).toBe(70);
  });

  it("prices in the region the user names", async () => {
    const service = createMigrationEstimateService(
      deps(
        [alpha, beta],
        [resource("vm1", "alpha", "instance", { size: "a.large", region: "na-1" })],
      ),
    );
    const result = await service.compute("org", input({ targetRegion: "eu-1" }));
    expect(result.region).toMatchObject({ region: "eu-1", choice: "user", crossesArea: true });
    expect(result.rows[0]!.target).toMatchObject({ sizeId: "b.medium-eu", region: "eu-1" });
  });

  it("says the source size is unknown rather than guessing one", async () => {
    const service = createMigrationEstimateService(
      deps([alpha, beta], [resource("vm2", "alpha", "instance", { size: "a.unknown" })]),
    );
    const result = await service.compute("org", input());
    expect(result.rows[0]!.note).toBe("source-size-unknown");
    expect(result.rows[0]!.target.cost).toBeNull();
    expect(result.totals.targetUnknown).toBe(1);
    expect(result.totals.target).toEqual([]);
  });

  it("sizes a target without a catalog from its create form, and needs an account for it", async () => {
    const gamma = plugin("gamma", [vmType("droplet")]);
    const sizeConfig: CreateResourceConfig = {
      fields: [
        {
          key: "size",
          label: "Size",
          kind: "size-picker",
          required: true,
          sizes: [
            { id: "g-2", label: "G 2", vcpus: 2, memoryMb: 4096, priceMonthly: 12 },
            { id: "g-4", label: "G 4", vcpus: 4, memoryMb: 16384, priceMonthly: 48 },
          ],
        },
      ],
    };
    const resources = [resource("vm1", "alpha", "instance", { size: "a.large", region: "na-1" })];
    const without = createMigrationEstimateService(deps([alpha, gamma], resources));
    const noAccount = await without.compute("org", input({ targetPluginId: "gamma" }));
    expect(noAccount.rows[0]!.note).toBe("no-account");

    const withAccount = createMigrationEstimateService(
      deps([alpha, gamma], resources, {
        listAccountIds: async (_org, pluginId) => (pluginId === "gamma" ? ["acct-gamma"] : []),
        createConfig: async () => sizeConfig,
        sizePricing: async () => ({ "g-4": 44 }),
      }),
    );
    const priced = await withAccount.compute("org", input({ targetPluginId: "gamma" }));
    expect(priced.rows[0]!.target).toMatchObject({
      sizeId: "g-4",
      cost: { amount: 44, currency: "USD", basis: "list-price" },
    });
  });

  it("prefers the target plugin's own estimate when it gives one", async () => {
    const service = createMigrationEstimateService(
      deps(
        [alpha, beta],
        [resource("vm1", "alpha", "instance", { size: "a.large", region: "na-1" })],
        {
          listAccountIds: async (_org, pluginId) => (pluginId === "beta" ? ["acct-beta"] : []),
          estimateTarget: async (_org, _account, typeId, fields) => {
            expect(typeId).toBe("server");
            expect(fields).toEqual({ size: "b.medium", region: "na-1" });
            return {
              monthlyAmount: 33.5,
              currency: "USD",
              lineItems: [{ label: "Server", monthlyAmount: 33.5 }],
              partial: true,
            };
          },
        },
      ),
    );
    const result = await service.compute("org", input());
    expect(result.rows[0]!.target.cost).toEqual({
      amount: 33.5,
      currency: "USD",
      basis: "estimate",
      partial: true,
    });
  });

  it("does not count a cluster's nodes twice when its pools are in the set", async () => {
    const delta = plugin("delta", [clusterType, poolType]);
    const service = createMigrationEstimateService(
      deps(
        [delta, beta],
        [
          resource("c1", "delta", "cluster", { nodeSize: "x", nodes: 3, region: "na-1" }),
          resource("p1", "delta", "pool", { size: "x", count: 3 }, { parentResourceId: "c1" }),
        ],
      ),
    );
    const result = await service.compute("org", input());
    // The target has neither category, so both are unmatched; the cluster's
    // sizing was dropped before matching.
    expect(result.unmatched.map((u) => u.reason)).toEqual(["no-target-type", "no-target-type"]);
  });

  it("refuses an unknown target and a missing service", async () => {
    const service = createMigrationEstimateService(deps([alpha, beta], []));
    await expect(service.compute("org", input({ targetPluginId: "nope" }))).rejects.toBeInstanceOf(
      MigrationEstimateInputError,
    );
    await expect(
      service.compute("org", input({ source: { kind: "service", serviceId: "gone" } })),
    ).rejects.toBeInstanceOf(MigrationEstimateSourceNotFoundError);
  });

  it("writes the target's Terraform through its own export", async () => {
    const service = createMigrationEstimateService(
      deps(
        [alpha, beta],
        [resource("vm1", "alpha", "instance", { size: "a.large", region: "na-1" })],
      ),
    );
    const result = await service.compute("org", input());
    const terraform = await service.terraform(result);
    expect(terraform?.hcl).toContain('resource "beta_server"');
    expect(terraform?.hcl).toContain('size   = "b.medium"');
    expect(terraform?.exported).toEqual([{ resourceId: "vm1", address: "beta_server.vm1" }]);
  });

  it("lists targets with their categories and regions", async () => {
    const service = createMigrationEstimateService(deps([alpha, beta], []));
    const targets = await service.targets("org");
    expect(targets.map((t) => [t.pluginId, t.categories])).toEqual([
      ["alpha", ["vm", "object-storage"]],
      ["beta", ["vm"]],
    ]);
    expect(targets[1]).toMatchObject({ priceCatalog: true, needsAccount: false, terraform: true });
  });
});
