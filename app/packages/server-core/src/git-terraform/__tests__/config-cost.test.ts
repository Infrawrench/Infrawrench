/**
 * Pricing a root from its configuration: the real scanner over small
 * repositories in memory, a warehouse that answers from a table, and an
 * account estimator that prices one plugin's servers. No network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ConfigurationPricingInputs,
  type TerraformSnapshotFile,
  scanTerraformSnapshot,
} from "@infrawrench/git-terraform";
import {
  clearInstanceRateCache,
  type InstancePricingHostServices,
  type TerraformExportCapability,
} from "@infrawrench/plugin-base";

// plan-cost reaches the database client at load; nothing here uses it.
vi.mock("../../db/client.js", () => ({ db: {} }));

const { priceConfiguration, classifyOther } = await import("../config-cost");
type ConfigCostDeps = import("../config-cost").ConfigCostDeps;

/** Hourly on-demand USD by `platform/region/type`. */
const RATES: Record<string, number> = {
  "ec2/us-east-2/t4g.medium": 0.0336,
  "ec2/us-east-1/m5.large": 0.096,
  "rds/us-east-1/db.t3.micro": 0.017,
  "gcp/us-central1/e2-medium": 0.03350571,
  "azure/westeurope/Standard_B2s": 0.048,
  "oracle/global/VM.Standard.A1.Flex-2-12": 0.032,
  "hetzner/fsn1/cx23": 0.0104,
};

/** A warehouse that answers `fetchInstanceOnDemandRates`'s query from {@link RATES}. */
function warehouse(): InstancePricingHostServices & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async query(sql) {
      queries.push(sql);
      const platform = /platform = '([^']+)'/.exec(sql)![1]!;
      const region = /region = '([^']+)'/.exec(sql)![1]!;
      const types = [.../instance_type IN \(([^)]*)\)/.exec(sql)![1]!.matchAll(/'([^']+)'/g)].map(
        (m) => m[1]!,
      );
      const rows = types
        .filter((type) => RATES[`${platform}/${region}/${type}`] !== undefined)
        .map((type) => [type, RATES[`${platform}/${region}/${type}`]!]);
      return {
        columns: [
          { name: "instanceType", type: "String" },
          { name: "hourly", type: "Float64" },
        ],
        rows,
        truncated: false,
        elapsedMs: 1,
      };
    },
  };
}

const capability = {
  supportedResourceTypeIds: ["droplet"],
  mapResource: (resource: { displayName: string; fields: Record<string, unknown> }) => ({
    resource: {
      type: "digitalocean_droplet",
      name: resource.displayName,
      attributes: { size: { kind: "string", value: String(resource.fields["size"]) } },
    },
  }),
} as unknown as TerraformExportCapability;

const DROPLETS: Record<string, number> = { "s-1vcpu-1gb": 6 };

function deps(over: Partial<ConfigCostDeps> = {}): ConfigCostDeps {
  return {
    capabilities: {
      capabilityFor: (pluginId) => (pluginId === "digitalocean" ? capability : undefined),
      typeMap: {
        byTerraformType: new Map([
          ["digitalocean_droplet", [{ pluginId: "digitalocean", resourceTypeId: "droplet" }]],
          ["aws_nat_gateway", [{ pluginId: "aws", resourceTypeId: "nat-gateway" }]],
        ]),
        byResourceType: new Map(),
        underivable: [],
      },
    },
    estimate: async (_organizationId, input) => {
      const amount = DROPLETS[input.fields?.["size"] ?? ""];
      return amount === undefined
        ? null
        : {
            monthlyAmount: amount,
            currency: "USD",
            lineItems: [{ label: "Droplet", monthlyAmount: amount }],
          };
    },
    pricing: warehouse(),
    accounts: [],
    pluginName: (pluginId) => ({ aws: "AWS", digitalocean: "DigitalOcean" })[pluginId] ?? pluginId,
    ...over,
  };
}

/** The pricing inputs of the root at `root` in a repository of these files. */
async function inputsOf(
  files: Record<string, string>,
  root = "",
): Promise<ConfigurationPricingInputs> {
  const snapshot: TerraformSnapshotFile[] = Object.entries(files).map(([path, text]) => ({
    path,
    text,
    size: text.length,
  }));
  const scan = await scanTerraformSnapshot({ files: snapshot, truncated: false });
  const found = scan.roots.find((candidate) => candidate.directory.path === root);
  if (!found) throw new Error(`no root at ${root}`);
  return found.pricing;
}

beforeEach(() => clearInstanceRateCache());

describe("pricing a configuration", () => {
  it("prices literal sizes with count and for_each, from the provider's region", async () => {
    const inputs = await inputsOf({
      "main.tf": `
        provider "aws" { region = "us-east-2" }
        resource "aws_instance" "web" {
          count         = 3
          instance_type = "t4g.medium"
        }
        resource "aws_instance" "job" {
          for_each      = toset(["a", "b"])
          instance_type = "t4g.medium"
        }
      `,
    });
    const { estimate, sourced } = await priceConfiguration(null, inputs, deps());
    expect(sourced).toBe(true);
    // 0.0336 × 730 = 24.53 a month, each.
    expect(estimate.lines).toEqual([
      {
        address: "aws_instance.web",
        type: "aws_instance",
        count: 3,
        monthly: 73.59,
        detail: "3 × t4g.medium, us-east-2, Linux, on demand, $24.53 each",
      },
      {
        address: "aws_instance.job",
        type: "aws_instance",
        count: 2,
        monthly: 49.06,
        detail: "2 × t4g.medium, us-east-2, Linux, on demand, $24.53 each",
      },
    ]);
    expect(estimate.monthlyTotal).toBe(122.65);
    expect(estimate.currency).toBe("USD");
    expect(estimate.complete).toBe(true);
  });

  it("reads sizes, counts and regions from variables with defaults", async () => {
    const inputs = await inputsOf({
      "variables.tf": `
        variable "region" { default = "us-east-1" }
        variable "size" { default = "m5.large" }
        variable "enabled" { default = true }
      `,
      "main.tf": `
        provider "aws" { region = var.region }
        locals { replicas = var.enabled ? 2 : 0 }
        resource "aws_instance" "app" {
          count         = local.replicas
          instance_type = var.size
        }
        resource "aws_db_instance" "db" {
          instance_class = "db.t3.micro"
          engine         = "postgres"
        }
      `,
    });
    const w = warehouse();
    const { estimate } = await priceConfiguration(null, inputs, deps({ pricing: w }));
    expect(estimate.lines.map((line) => [line.address, line.count, line.monthly])).toEqual([
      ["aws_instance.app", 2, 140.16],
      ["aws_db_instance.db", 1, 12.41],
    ]);
    // The engine and deployment are part of the price asked for.
    expect(
      w.queries.some((sql) => sql.includes("'PostgreSQL'") && sql.includes("'Single-AZ'")),
    ).toBe(true);
  });

  it("lists what it cannot price, with why, and never counts it as zero", async () => {
    const inputs = await inputsOf({
      "main.tf": `
        provider "aws" { region = "us-east-1" }
        variable "size" {}
        resource "aws_instance" "unknown_size" { instance_type = var.size }
        resource "aws_instance" "computed_count" {
          count         = length(data.aws_availability_zones.all.names)
          instance_type = "m5.large"
        }
        resource "aws_instance" "no_price" { instance_type = "x9.mystery" }
        resource "aws_db_instance" "no_engine" { instance_class = "db.t3.micro" }
        resource "aws_nat_gateway" "nat" {}
        resource "aws_instance" "priced" { instance_type = "m5.large" }
        module "vpc" { source = "terraform-aws-modules/vpc/aws" }
      `,
    });
    const { estimate } = await priceConfiguration(null, inputs, deps());
    expect(estimate.monthlyTotal).toBe(70.08);
    expect(estimate.complete).toBe(false);
    expect(
      Object.fromEntries(estimate.unpriced.map((item) => [item.address, item.reason])),
    ).toEqual({
      "aws_db_instance.no_engine": "engine is not set",
      "aws_instance.computed_count": "count or for_each is not known from the configuration",
      "aws_instance.no_price": "no list price for x9.mystery in us-east-1",
      "aws_instance.unknown_size": "instance_type is not known from the configuration",
      "aws_nat_gateway.nat": "priced through a connected AWS account; none is connected",
      "module.vpc": "a module from terraform-aws-modules/vpc/aws is not read",
    });
  });

  it("says a region is missing rather than picking one", async () => {
    const inputs = await inputsOf({
      "main.tf": `resource "aws_instance" "a" { instance_type = "m5.large" }`,
    });
    const { estimate } = await priceConfiguration(null, inputs, deps());
    expect(estimate.unpriced).toEqual([
      {
        address: "aws_instance.a",
        type: "aws_instance",
        reason: "region is not set in the configuration",
      },
    ]);
    expect(estimate.monthlyTotal).toBeNull();
  });

  it("takes Google Cloud's region from the zone and Azure's from the location", async () => {
    const inputs = await inputsOf({
      "main.tf": `
        provider "google" { region = "europe-west4" }
        resource "google_compute_instance" "vm" {
          machine_type = "e2-medium"
          zone         = "us-central1-a"
        }
        resource "azurerm_linux_virtual_machine" "vm" {
          size     = "Standard_B2s"
          location = "West Europe"
        }
        resource "hcloud_server" "box" {
          server_type = "cx23"
          location    = "fsn1"
        }
      `,
    });
    const w = warehouse();
    const { estimate } = await priceConfiguration(null, inputs, deps({ pricing: w }));
    expect(estimate.lines.map((line) => line.detail).sort()).toEqual([
      "1 × Standard_B2s, westeurope, Linux, on demand, $35.04 each",
      "1 × cx23, fsn1, on demand, $7.59 each",
      "1 × e2-medium, us-central1, on demand, $24.46 each",
    ]);
    expect(
      w.queries.some((sql) => sql.includes("variant['provisioningModel'] IN ('Standard'")),
    ).toBe(true);
    expect(w.queries.some((sql) => sql.includes("variant['priority'] IN ('Regular'"))).toBe(true);
  });

  it("prices an Oracle flexible shape by its OCPUs and memory, and says when they are not known", async () => {
    const inputs = await inputsOf({
      "main.tf": `
        resource "oci_core_instance" "sized" {
          shape = "VM.Standard.A1.Flex"
          shape_config {
            ocpus         = 2
            memory_in_gbs = 12
          }
        }
        resource "oci_core_instance" "bare" { shape = "VM.Standard.A1.Flex" }
      `,
    });
    const { estimate } = await priceConfiguration(null, inputs, deps());
    expect(estimate.lines.map((line) => line.detail)).toEqual([
      "1 × VM.Standard.A1.Flex-2-12, global, on demand, $23.36 each",
    ]);
    expect(estimate.unpriced).toEqual([
      {
        address: "oci_core_instance.bare",
        type: "oci_core_instance",
        reason: "flexible shape: priced by its OCPUs and memory, which are not known",
      },
    ]);
  });

  it("prices through an account only where the organisation has one", async () => {
    const files = {
      "main.tf": `
        resource "digitalocean_droplet" "web" {
          count = 2
          size  = "s-1vcpu-1gb"
        }
      `,
    };
    const inputs = await inputsOf(files);
    const estimate = vi.fn(deps().estimate);

    const personal = await priceConfiguration(null, inputs, deps({ estimate }));
    expect(estimate).not.toHaveBeenCalled();
    expect(personal.estimate.unpriced[0]?.reason).toBe(
      "priced through a connected DigitalOcean account; none is connected",
    );

    const without = await priceConfiguration("org-1", inputs, deps({ estimate }));
    expect(estimate).not.toHaveBeenCalled();
    expect(without.estimate.monthlyTotal).toBeNull();

    const withAccount = await priceConfiguration(
      "org-1",
      inputs,
      deps({ estimate, accounts: [{ id: "acct-1", pluginId: "digitalocean" }] }),
    );
    expect(estimate).toHaveBeenCalledWith("org-1", {
      accountId: "acct-1",
      resourceTypeId: "droplet",
      fields: { size: "s-1vcpu-1gb" },
    });
    expect(withAccount.estimate.lines).toEqual([
      {
        address: "digitalocean_droplet.web",
        type: "digitalocean_droplet",
        count: 2,
        monthly: 12,
        detail: "2 × $6.00 a month, from the connected DigitalOcean account's pricing",
      },
    ]);
    expect(withAccount.estimate.complete).toBe(true);
  });

  it("counts what is billed by use or costs nothing on its own, and keeps the rest unknown", async () => {
    const inputs = await inputsOf({
      "main.tf": `
        provider "aws" { region = "us-east-1" }
        resource "aws_lambda_function" "fn" {}
        resource "aws_s3_bucket" "b" { count = 2 }
        resource "aws_iam_role" "r" {}
        resource "aws_security_group" "sg" {}
        resource "aws_route_table_association" "a" {}
        resource "aws_mystery_thing" "m" {}
        resource "random_password" "p" { length = 16 }
      `,
    });
    const { estimate } = await priceConfiguration(null, inputs, deps());
    expect(estimate.others).toEqual(
      expect.arrayContaining([
        { type: "aws_s3_bucket", count: 2, kind: "usage" },
        { type: "aws_lambda_function", count: 1, kind: "usage" },
        { type: "aws_iam_role", count: 1, kind: "free" },
        { type: "aws_security_group", count: 1, kind: "free" },
        { type: "aws_route_table_association", count: 1, kind: "free" },
        { type: "aws_mystery_thing", count: 1, kind: "unknown" },
      ]),
    );
    // A provider of no account (`random`) is not a resource that costs anything.
    expect(estimate.others.some((other) => other.type === "random_password")).toBe(false);
    expect(estimate.complete).toBe(false);
  });

  it("has no price source on a deployment with no warehouse and no account", async () => {
    const inputs = await inputsOf({
      "main.tf": `
        provider "aws" { region = "us-east-1" }
        resource "aws_instance" "a" { instance_type = "m5.large" }
      `,
    });
    const { estimate, sourced } = await priceConfiguration(
      null,
      inputs,
      deps({ pricing: undefined }),
    );
    expect(sourced).toBe(false);
    expect(estimate.unpriced[0]?.reason).toBe("this deployment has no instance price data");
  });

  it("classifies names the way the documentation says", () => {
    expect(classifyOther("aws_vpc")).toBe("free");
    expect(classifyOther("aws_vpc_endpoint")).toBe("fixed");
    expect(classifyOther("aws_autoscaling_group")).toBe("unknown");
    expect(classifyOther("aws_cloudwatch_log_group")).toBe("usage");
    expect(classifyOther("google_project_service")).toBe("free");
    expect(classifyOther("aws_nat_gateway")).toBe("fixed");
  });
});
