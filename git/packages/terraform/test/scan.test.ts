import { describe, expect, it } from "vitest";

import {
  type ConfigurationEstimate,
  type HclValue,
  type Scope,
  MAX_CONFIGURATION_RESOURCES,
  type TerraformSnapshot,
  UNKNOWN,
  compareConfigurationEstimates,
  evaluate,
  isTerraformScanFile,
  scanTerraformSnapshot,
  summarizeScan,
} from "../src/index.js";

/** A snapshot from a map of file paths to contents. */
const snapshot = (files: Record<string, string>, truncated = false): TerraformSnapshot => ({
  files: Object.entries(files).map(([path, text]) => ({ path, text, size: text.length })),
  truncated,
});

const scope = (
  variables: Record<string, HclValue>,
  locals: Record<string, string> = {},
): Scope => ({
  variable: (name) => (name in variables ? variables[name]! : UNKNOWN),
  local: (name) => (name in locals ? evaluate(locals[name]!) : UNKNOWN),
});

describe("evaluate", () => {
  it("reads literals, operators, conditionals and collections", () => {
    expect(evaluate("3")).toBe(3);
    expect(evaluate('"t3.micro"')).toBe("t3.micro");
    expect(evaluate("2 * (1 + 2) - 1")).toBe(5);
    expect(evaluate("true && !false ? 1 : 0")).toBe(1);
    expect(evaluate('["a", "b"]')).toEqual(["a", "b"]);
    expect(evaluate('{ a = 1, "b" = 2 }')).toEqual({ a: 1, b: 2 });
    expect(evaluate('{ a = { size = "x" } }.a.size')).toBe("x");
    expect(evaluate("[10, 20][1]")).toBe(20);
    expect(evaluate('"1" == 1')).toBe(false);
  });

  it("reads variables, locals and templates through the scope", () => {
    const s = scope({ env: "prod", nodes: 3 });
    expect(evaluate("var.nodes > 2 ? var.nodes : 1", s)).toBe(3);
    expect(evaluate('"${var.env}-web"', s)).toBe("prod-web");
    expect(evaluate('var.env == "prod" ? "m5.large" : "t3.small"', s)).toBe("m5.large");
    expect(evaluate("var.missing", s)).toBe(UNKNOWN);
  });

  it("runs the pure functions it knows and nothing else", () => {
    expect(evaluate('length(["a", "b", "c"])')).toBe(3);
    expect(evaluate('toset(["a", "a", "b"])')).toEqual(["a", "b"]);
    expect(evaluate('lookup({ a = 1 }, "b", 7)')).toBe(7);
    expect(evaluate("merge({ a = 1 }, { b = 2 })")).toEqual({ a: 1, b: 2 });
    expect(evaluate('try(var.x.y, "fallback")', scope({ x: {} }))).toBe("fallback");
    expect(evaluate('coalesce("", "b")')).toBe("b");
    expect(evaluate('file("secrets.txt")')).toBe(UNKNOWN);
    expect(evaluate('templatefile("x", {})')).toBe(UNKNOWN);
  });

  it("is unknown for what a run decides, and spreads it", () => {
    expect(evaluate("aws_vpc.main.id")).toBe(UNKNOWN);
    expect(evaluate("data.aws_ami.x.id")).toBe(UNKNOWN);
    expect(evaluate('"${aws_vpc.main.id}-x"')).toBe(UNKNOWN);
    expect(evaluate("[for x in var.list : x]")).toBe(UNKNOWN);
    expect(evaluate("aws_vpc.main.id == null ? 1 : 0")).toBe(UNKNOWN);
    // An unknown condition with the same answer either way is still known.
    expect(evaluate("aws_vpc.main.id == null ? 1 : 1")).toBe(1);
    // `false && unknown` is false whatever the unknown is.
    expect(evaluate("false && aws_vpc.main.enabled")).toBe(false);
  });

  it("never throws, and is unknown for broken or hostile text", () => {
    for (const text of ['"unterminated', "(((((", "1 +", "{ a = }", "a.b[", "~~~", ""]) {
      expect(evaluate(text), text).toBe(UNKNOWN);
    }
    const deep = `${"(".repeat(500)}1${")".repeat(500)}`;
    expect(evaluate(deep)).toBe(UNKNOWN);
    const wide = `[${Array.from({ length: 30_000 }, () => "1").join(",")}]`;
    expect(evaluate(wide)).toBe(UNKNOWN);
  });
});

describe("isTerraformScanFile", () => {
  it("takes configuration, variable files and the lock file", () => {
    for (const name of [
      "main.tf",
      "main.tf.json",
      "x.tofu",
      "terraform.tfvars",
      "prod.auto.tfvars.json",
      ".terraform.lock.hcl",
    ]) {
      expect(isTerraformScanFile(name), name).toBe(true);
    }
    for (const name of ["README.md", ".hidden.tf", "terraform.tfstate", "x.tfvars.example"]) {
      expect(isTerraformScanFile(name), name).toBe(false);
    }
  });
});

const REPOSITORY = {
  // A root with a backend, a local module called twice and a registry module.
  "envs/prod/main.tf": `
    terraform {
      required_version = ">= 1.6"
      backend "s3" {
        bucket     = "acme-state"
        key        = "prod/terraform.tfstate"
        region     = "eu-west-1"
        access_key = "AKIAEXAMPLEEXAMPLE00"
      }
      required_providers {
        aws = { source = "hashicorp/aws", version = "~> 6.0" }
      }
    }
    provider "aws" { region = var.region }
    variable "region" { default = "eu-west-1" }
    variable "web_count" { default = 2 }
    variable "db_password" { sensitive = true }
    module "web" {
      // ci-reads-ignore: Terraform source in a fixture, written to a temporary directory
      source        = "../../modules/web"
      count         = var.web_count
      instance_type = "m5.large"
    }
    module "api" {
      // ci-reads-ignore: Terraform source in a fixture, written to a temporary directory
      source = "../../modules/web"
    }
    module "vpc" {
      source  = "terraform-aws-modules/vpc/aws"
      version = "5.0.0"
    }
    resource "aws_db_instance" "main" {
      instance_class = "db.t4g.medium"
      engine         = "postgres"
      password       = var.db_password
      multi_az       = true
    }
    output "db" { value = aws_db_instance.main.address }
  `,
  "envs/prod/.terraform.lock.hcl": "# lock",
  "envs/prod/terraform.tfvars": "web_count = 3\n",
  "modules/web/main.tf": `
    variable "instance_type" { default = "t3.micro" }
    resource "aws_instance" "this" {
      instance_type = var.instance_type
      ami           = data.aws_ami.al2023.id
      root_block_device { volume_size = 30 }
    }
    data "aws_ami" "al2023" {}
  `,
  // A root with no backend: local state.
  "sandbox/main.tf": `
    provider "google" { region = "us-central1" }
    locals {
      machines = { a = "e2-small", b = "e2-small", c = "e2-medium" }
    }
    resource "google_compute_instance" "vm" {
      for_each     = local.machines
      machine_type = each.value
      zone         = "us-central1-a"
    }
    resource "random_id" "suffix" { byte_length = 4 }
  `,
  // The JSON syntax.
  "json/main.tf.json": JSON.stringify({
    terraform: { backend: { gcs: { bucket: "b", prefix: "p" } } },
    resource: {
      hcloud_server: { web: { server_type: "cpx11", location: "fsn1", count: 2 } },
    },
  }),
  // Not a root: nothing to run.
  "docs/example.tf": "# nothing here\n",
};

describe("scanTerraformSnapshot", () => {
  it("finds every root, reads what each declares, and counts through local modules", async () => {
    const scan = await scanTerraformSnapshot(snapshot(REPOSITORY));
    expect(scan.roots.map((root) => root.directory.path)).toEqual(["envs/prod", "json", "sandbox"]);
    const summary = summarizeScan(scan);
    const prod = summary.roots.find((root) => root.path === "envs/prod")!;
    expect(prod.backend).toEqual({
      type: "s3",
      // The credential is never read, even as a literal.
      settings: [
        { name: "bucket", value: "acme-state" },
        { name: "key", value: "prod/terraform.tfstate" },
        { name: "region", value: "eu-west-1" },
      ],
    });
    expect(prod.requiredVersion).toBe(">= 1.6");
    expect(prod.lockFile).toBe(true);
    expect(prod.tfvarsFiles).toEqual(["terraform.tfvars"]);
    expect(prod.localModules).toEqual(["modules/web"]);
    expect(prod.modules.map((module) => [module.name, module.localPath, module.version])).toEqual([
      ["web", "modules/web", null],
      ["api", "modules/web", null],
      ["vpc", null, "5.0.0"],
    ]);
    // Its own resource and its module's, as declared.
    expect(prod.resourceCount).toBe(2);
    expect(prod.dataSourceCount).toBe(1);
    expect(prod.providers).toEqual([
      {
        name: "aws",
        source: "hashicorp/aws",
        version: "~> 6.0",
        configured: true,
        resources: 2,
        dataSources: 1,
      },
    ]);
    expect(prod.requiredVariables).toEqual(["db_password"]);
    expect(prod.outputCount).toBe(1);

    const sandbox = summary.roots.find((root) => root.path === "sandbox")!;
    expect(sandbox.backend).toBeNull();
    expect(sandbox.reasons).toEqual(["provider-block"]);
    const json = summary.roots.find((root) => root.path === "json")!;
    expect(json.backend).toEqual({ type: "gcs", settings: expect.any(Array) });
    expect(summary.moduleCount).toBe(2);
    expect(JSON.stringify(summary)).not.toContain("AKIAEXAMPLE");
  });

  it("resolves count and for_each from literals, defaults and tfvars, through modules", async () => {
    const scan = await scanTerraformSnapshot(snapshot(REPOSITORY));
    const prod = scan.roots.find((root) => root.directory.path === "envs/prod")!.pricing;
    const byAddress = new Map(prod.resources.map((resource) => [resource.address, resource]));

    // `count = var.web_count`, 3 from terraform.tfvars, one instance each.
    for (const i of [0, 1, 2]) {
      const web = byAddress.get(`module.web[${i}].aws_instance.this`)!;
      expect(web.count).toBe(1);
      expect(web.attributes["instance_type"]).toBe("m5.large");
      expect(web.attributes["root_block_device.volume_size"]).toBe(30);
      expect(web.providerRegion).toBe("eu-west-1");
      expect(web.unknownAttributes).toEqual(["ami"]);
    }
    // The module's default when the caller passes nothing.
    expect(byAddress.get("module.api.aws_instance.this")!.attributes["instance_type"]).toBe(
      "t3.micro",
    );
    const db = byAddress.get("aws_db_instance.main")!;
    expect(db.attributes).toEqual({
      instance_class: "db.t4g.medium",
      engine: "postgres",
      multi_az: true,
    });
    // A credential is neither read nor listed as unknown.
    expect(db.unknownAttributes).toEqual([]);
    expect(prod.unreadModules).toEqual([
      { address: "module.vpc", source: "terraform-aws-modules/vpc/aws" },
    ]);

    // for_each over a local map: instances with the same values fold into one line.
    const sandbox = scan.roots.find((root) => root.directory.path === "sandbox")!.pricing;
    expect(
      sandbox.resources.map((resource) => [
        resource.address,
        resource.count,
        resource.attributes["machine_type"],
      ]),
    ).toEqual([
      ['google_compute_instance.vm["a", "b"]', 2, "e2-small"],
      ['google_compute_instance.vm["c"]', 1, "e2-medium"],
    ]);
    // Nothing of a provider with no account is listed.
    expect(sandbox.resources.some((resource) => resource.type === "random_id")).toBe(false);

    const json = scan.roots.find((root) => root.directory.path === "json")!.pricing;
    expect(json.resources).toEqual([
      expect.objectContaining({
        address: "hcloud_server.web",
        count: 2,
        attributes: { server_type: "cpx11", location: "fsn1" },
      }),
    ]);
  });

  it("says when a count is not known, and never guesses one", async () => {
    const scan = await scanTerraformSnapshot(
      snapshot({
        "main.tf": `
          provider "aws" {}
          variable "enabled" { type = bool }
          resource "aws_nat_gateway" "x" {
            count         = var.enabled ? 1 : 0
            allocation_id = aws_eip.x.id
          }
          resource "aws_instance" "y" {
            count         = length(data.aws_subnets.all.ids)
            instance_type = "t3.small"
          }
          resource "aws_instance" "off" {
            count         = 0
            instance_type = "t3.small"
          }
        `,
      }),
    );
    const resources = scan.roots[0]!.pricing.resources;
    expect(resources.map((resource) => [resource.address, resource.count])).toEqual([
      ["aws_nat_gateway.x", null],
      ["aws_instance.y", null],
    ]);
    // A count of zero is switched off, and said so rather than dropped.
    expect(scan.roots[0]!.pricing.inactive).toEqual(["aws_instance.off"]);
    expect(summarizeScan(scan).roots[0]!.inactiveResources).toBe(1);
    // The provider has no region in the configuration.
    expect(resources[1]!.providerRegion).toBeNull();
  });

  it("reads past files it cannot parse, and says which", async () => {
    const scan = await scanTerraformSnapshot(
      snapshot({
        "a/main.tf": 'provider "aws" {}\nresource "aws_instance" "x" { instance_type = "t3.nano" }',
        "a/broken.tf": 'resource "aws_instance" "y" {\n  instance_type = "unterminated\n',
        "a/broken.tf.json": "{ not json",
      }),
    );
    const [root] = summarizeScan(scan).roots;
    expect(root!.unreadable.map((item) => item.file).sort()).toEqual([
      "a/broken.tf",
      "a/broken.tf.json",
    ]);
    expect(scan.roots[0]!.pricing.resources.map((resource) => resource.address)).toEqual([
      "aws_instance.x",
    ]);
  });

  it("stops at its limits and says so", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 250; i++) many[`big/f${i}.tf`] = `resource "aws_s3_bucket" "b${i}" {}`;
    const wide = await scanTerraformSnapshot(snapshot(many));
    expect(wide.truncated).toBe(true);

    const huge = await scanTerraformSnapshot(
      snapshot({
        "main.tf": `provider "aws" {}\n${Array.from(
          { length: MAX_CONFIGURATION_RESOURCES + 10 },
          (_, i) => `resource "aws_s3_bucket" "b${i}" {}`,
        ).join("\n")}`,
      }),
    );
    expect(huge.roots[0]!.pricing.truncated).toBe(true);
    expect(huge.roots[0]!.pricing.resources).toHaveLength(MAX_CONFIGURATION_RESOURCES);

    // What the storage's walk could not read is passed on.
    const partial = await scanTerraformSnapshot(snapshot({ "main.tf": 'provider "aws" {}' }, true));
    expect(partial.truncated).toBe(true);
  });

  it("does not loop on modules that call each other", async () => {
    const scan = await scanTerraformSnapshot(
      snapshot({
        "root/main.tf": 'provider "aws" {}\nmodule "a" { source = "../a" }',
        "a/main.tf": 'module "b" { source = "../b" }\nresource "aws_eip" "a" {}',
        "b/main.tf": 'module "a" { source = "../a" }\nresource "aws_eip" "b" {}',
      }),
    );
    const root = scan.roots.find((r) => r.directory.path === "root")!;
    expect(root.pricing.resources.map((resource) => resource.address)).toEqual([
      "module.a.aws_eip.a",
      "module.a.module.b.aws_eip.b",
    ]);
  });
});

describe("compareConfigurationEstimates", () => {
  const estimate = (
    lines: Array<[string, number]>,
    extra: Partial<ConfigurationEstimate> = {},
  ): ConfigurationEstimate => ({
    currency: "USD",
    monthlyTotal: lines.reduce((sum, [, monthly]) => sum + monthly, 0),
    complete: true,
    lines: lines.map(([address, monthly]) => ({
      address,
      type: address.split(".")[0]!,
      count: 1,
      monthly,
      detail: "",
    })),
    unpriced: [],
    others: [],
    ...extra,
  });

  it("lists what changed, largest first, with the totals", () => {
    const change = compareConfigurationEstimates(
      estimate([
        ["aws_instance.web", 60],
        ["aws_db_instance.main", 100],
      ]),
      estimate([
        ["aws_instance.web", 120],
        ["aws_db_instance.main", 100],
        ["aws_instance.worker", 30],
      ]),
    );
    expect(change.monthlyBefore).toBe(160);
    expect(change.monthlyAfter).toBe(250);
    expect(change.monthlyDelta).toBe(90);
    expect(change.complete).toBe(true);
    expect(change.lines).toEqual([
      {
        address: "aws_instance.web",
        type: "aws_instance",
        monthlyBefore: 60,
        monthlyAfter: 120,
        monthlyDelta: 60,
      },
      {
        address: "aws_instance.worker",
        type: "aws_instance",
        monthlyBefore: null,
        monthlyAfter: 30,
        monthlyDelta: 30,
      },
    ]);
  });

  it("counts a new root as all added and a removed one as all gone", () => {
    expect(compareConfigurationEstimates(null, estimate([["a.x", 10]])).monthlyDelta).toBe(10);
    expect(compareConfigurationEstimates(estimate([["a.x", 10]]), null).monthlyDelta).toBe(-10);
  });

  it("is never complete when either side is not, and names only new failures", () => {
    const failing = { address: "aws_nat_gateway.x", type: "aws_nat_gateway", reason: "r" };
    const change = compareConfigurationEstimates(
      estimate([], { unpriced: [failing], complete: false }),
      estimate([], {
        unpriced: [failing, { ...failing, address: "aws_lb.y", type: "aws_lb" }],
        complete: false,
      }),
    );
    expect(change.complete).toBe(false);
    expect(change.unpriced.map((item) => item.address)).toEqual(["aws_lb.y"]);
  });

  it("has no delta when a side priced nothing or the currencies differ", () => {
    expect(
      compareConfigurationEstimates(estimate([]), estimate([], { monthlyTotal: null }))
        .monthlyDelta,
    ).toBeNull();
    const euro = compareConfigurationEstimates(
      estimate([["a.x", 1]]),
      estimate([["a.x", 2]], { currency: "EUR" }),
    );
    expect(euro.monthlyDelta).toBeNull();
    expect(euro.complete).toBe(false);
  });
});
