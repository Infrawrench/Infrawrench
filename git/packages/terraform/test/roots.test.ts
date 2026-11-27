import { describe, expect, it } from "vitest";

import {
  HclSyntaxError,
  discoverTerraformDirectories,
  discoverTerraformRoots,
  hclItems,
  isWorkspaceName,
  literalString,
  resolveLocalSource,
  suggestWorkspaceName,
  type TreeNode,
  type TreeReader,
} from "../src/index.js";

/** A tree from a map of file paths to contents. */
function tree(files: Record<string, string>): TreeReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    list(path) {
      const prefix = path === "" ? "" : `${path}/`;
      const nodes = new Map<string, TreeNode>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(prefix)) continue;
        const [name, ...rest] = file.slice(prefix.length).split("/");
        nodes.set(name!, { name: name!, kind: rest.length > 0 ? "directory" : "file" });
      }
      return Promise.resolve([...nodes.values()]);
    },
    read(path) {
      reads.push(path);
      const content = files[path];
      return Promise.resolve(content === undefined ? null : new TextEncoder().encode(content));
    },
  };
}

/**
 * A module source as a configuration writes it, relative to the calling
 * directory. Fixture text: it is resolved inside the in-memory tree a test
 * builds and never read from this checkout.
 */
// ci-reads-ignore: a Terraform module source in a fixture, not a path this test reads
const NETWORK_MODULE = "../../modules/network";

describe("hclItems", () => {
  it("reads blocks, labels and attributes", () => {
    const items = hclItems(`
      terraform {
        required_version = ">= 1.5"
        backend "s3" {
          bucket = "state"
        }
      }
      resource "aws_instance" "web" { ami = "ami-1" }
      locals { a = 1 }
      name = "top"
    `);
    expect(
      items.map((item) => (item.kind === "block" ? [item.type, ...item.labels] : item.name)),
    ).toEqual([["terraform"], ["resource", "aws_instance", "web"], ["locals"], "name"]);
    const terraform = items[0]!;
    expect(terraform.kind === "block" && hclItems(terraform.body)).toMatchObject([
      { kind: "attribute", name: "required_version", expression: '">= 1.5"' },
      { kind: "block", type: "backend", labels: ["s3"] },
    ]);
  });

  it("is not fooled by braces in comments, strings, templates and heredocs", () => {
    const items = hclItems(`
      # provider "fake" {
      // provider "fake2" {
      /* provider "fake3" { */
      resource "aws_iam_policy" "p" {
        name   = "a } b { \${var.x == "}" ? "{" : "}"}"
        policy = <<-EOT
          { "Statement": [ } } }
          provider "inside" {
        EOT
        other  = jsonencode({ a = "}" })
      }
      provider "aws" {
        region = "eu-west-1" # } trailing
      }
    `);
    expect(items.map((item) => (item.kind === "block" ? item.type : item.name))).toEqual([
      "resource",
      "provider",
    ]);
    const resource = items[0]!;
    expect(
      resource.kind === "block" &&
        hclItems(resource.body).map((i) => i.kind === "attribute" && i.name),
    ).toEqual(["name", "policy", "other"]);
  });

  it("reads an expression over several lines, to its end", () => {
    const items = hclItems('tags = {\n  a = "1"\n  b = "2"\n}\nnext = [\n  1,\n]\nlast = 3 // c\n');
    expect(items).toEqual([
      { kind: "attribute", name: "tags", expression: '{\n  a = "1"\n  b = "2"\n}' },
      { kind: "attribute", name: "next", expression: "[\n  1,\n]" },
      { kind: "attribute", name: "last", expression: "3" },
    ]);
  });

  it("says so when something never closes", () => {
    expect(() => hclItems('resource "a" "b" {')).toThrow(HclSyntaxError);
    expect(() => hclItems('x = "unterminated')).toThrow(HclSyntaxError);
    expect(() => hclItems("x = <<EOT\nno end")).toThrow(HclSyntaxError);
    expect(() => hclItems(`x = ${"[".repeat(500)}`)).toThrow(/too deeply/);
  });

  it("only takes a plain string as a literal", () => {
    expect(literalString('"./modules/vpc"')).toBe("./modules/vpc");
    expect(literalString('"a\\"b"')).toBe('a"b');
    expect(literalString('"${path.module}/x"')).toBeNull();
    expect(literalString("var.source")).toBeNull();
    expect(literalString('"a" + "b"')).toBeNull();
  });
});

describe("resolveLocalSource", () => {
  it("resolves against the calling directory and stays inside the repository", () => {
    // ci-reads-ignore: a module source resolved inside a repository's tree, never a path here
    expect(resolveLocalSource("envs/prod", "../../modules/vpc")).toBe("modules/vpc");
    expect(resolveLocalSource("", "./modules/vpc/")).toBe("modules/vpc");
    // ci-reads-ignore: the same, a source that climbs out of the repository it is in
    expect(resolveLocalSource("envs", "../..")).toBeNull();
    expect(resolveLocalSource("envs", "hashicorp/consul/aws")).toBeNull();
    expect(resolveLocalSource("envs", "git::https://example.com/vpc.git")).toBeNull();
  });
});

describe("discovering roots", () => {
  const repository = {
    "README.md": "# infra",
    "envs/prod/main.tf": `
      terraform {
        required_version = "~> 1.9"
        backend "s3" {
          bucket = "acme-state"
        }
        required_providers {
          aws = {
            source  = "hashicorp/aws"
            version = "~> 5.0"
          }
          random = { source = "hashicorp/random" }
        }
      }
      provider "aws" {
        region = var.region
      }
      module "network" {
        source = "${NETWORK_MODULE}"
        cidr   = "10.0.0.0/16"
      }
      module "registry" {
        source  = "terraform-aws-modules/ecr/aws"
        version = "2.0.0"
      }
    `,
    "envs/prod/variables.tf": `
      variable "region" {
        type    = string
        default = "eu-west-1"
      }
      variable "db_password" {
        type      = string
        sensitive = true
      }
    `,
    "envs/staging/main.tf": `
      provider "aws" {}
      module "network" { source = "${NETWORK_MODULE}" }
      resource "aws_s3_bucket" "assets" {}
      data "aws_caller_identity" "me" {}
    `,
    "modules/network/main.tf": `
      terraform {
        required_providers {
          aws = { source = "hashicorp/aws" }
        }
      }
      resource "aws_vpc" "this" {}
      module "subnets" { source = "./subnets" }
    `,
    "modules/network/subnets/main.tf": 'resource "aws_subnet" "a" {}',
    "modules/unused/main.tf": 'resource "aws_sqs_queue" "q" {}',
    "legacy/provider-in-module/main.tf": 'provider "aws" {}\nresource "aws_sns_topic" "t" {}',
    "legacy/caller/main.tf": 'module "old" { source = "../provider-in-module" }',
    "dns/zones.tf.json": JSON.stringify({
      terraform: { backend: { gcs: { bucket: "dns-state" } } },
      provider: { google: { project: "acme" } },
      resource: { google_dns_managed_zone: { main: {}, internal: {} } },
      variable: { project: { default: "acme" }, token: { sensitive: true } },
    }),
    "scratch/main.tf": 'resource "null_resource" "x" {}',
    "shared/variables.tf": 'variable "tags" {}',
    "broken/main.tf": 'resource "a" "b" {',
    "broken/ok.tf": 'resource "terraform_data" "x" {}',
    ".terraform/modules/network/main.tf": 'provider "aws" {}',
    "node_modules/pkg/main.tf": 'provider "aws" {}',
    "envs/prod/.terraform/x/main.tf": 'provider "aws" {}',
    "docs/notes.txt": "not terraform",
  };

  it("tells roots from modules, with the reason", async () => {
    const { directories, truncated } = await discoverTerraformDirectories(tree(repository));
    expect(truncated).toBe(false);
    expect(directories.map((d) => [d.path, d.kind, d.reasons])).toEqual([
      ["broken", "root", ["unreferenced"]],
      ["dns", "root", ["backend"]],
      ["envs/prod", "root", ["backend"]],
      ["envs/staging", "root", ["provider-block"]],
      ["legacy/caller", "root", ["unreferenced"]],
      // A module with a provider block of its own is still a module: something calls it.
      ["legacy/provider-in-module", "module", ["called-as-module"]],
      ["modules/network", "module", ["called-as-module"]],
      ["modules/network/subnets", "module", ["called-as-module"]],
      ["modules/unused", "module", ["modules-directory"]],
      ["scratch", "root", ["unreferenced"]],
      ["shared", "module", ["nothing-to-run"]],
    ]);
  });

  it("reads what a root declares", async () => {
    const { roots } = await discoverTerraformRoots(tree(repository));
    const prod = roots.find((root) => root.path === "envs/prod")!;
    expect(prod).toMatchObject({
      backend: "s3",
      providers: ["aws"],
      requiredProviders: { aws: "hashicorp/aws", random: "hashicorp/random" },
      requiredVersion: "~> 1.9",
      resourceCount: 0,
      calledBy: [],
    });
    expect(prod.moduleCalls).toEqual([
      { name: "network", source: NETWORK_MODULE, localPath: "modules/network" },
      { name: "registry", source: "terraform-aws-modules/ecr/aws", localPath: null },
    ]);
    expect(prod.variables).toEqual([
      { name: "region", required: false, sensitive: false },
      { name: "db_password", required: true, sensitive: true },
    ]);

    const dns = roots.find((root) => root.path === "dns")!;
    expect(dns).toMatchObject({ backend: "gcs", providers: ["google"], resourceCount: 2 });
    expect(dns.variables).toEqual([
      { name: "project", required: false, sensitive: false },
      { name: "token", required: true, sensitive: true },
    ]);

    expect(roots.find((root) => root.path === "envs/staging")).toMatchObject({
      resourceCount: 1,
      dataSourceCount: 1,
    });
  });

  it("records who calls a module", async () => {
    const { directories } = await discoverTerraformDirectories(tree(repository));
    expect(directories.find((d) => d.path === "modules/network")?.calledBy).toEqual([
      "envs/prod",
      "envs/staging",
    ]);
  });

  it("keeps going past a file it cannot read, and says which", async () => {
    const { directories } = await discoverTerraformDirectories(tree(repository));
    const broken = directories.find((d) => d.path === "broken")!;
    expect(broken.resourceCount).toBe(1);
    expect(broken.unreadable).toEqual([{ file: "main.tf", reason: "A { is never closed" }]);
  });

  it("says a JSON file is not JSON without quoting what is in it", async () => {
    // A JSON parser's own message quotes the text around the error.
    const { directories } = await discoverTerraformDirectories(
      tree({
        "main.tf": 'resource "terraform_data" "x" {}',
        "secrets.tf.json": '{"variable": {"token": {"default": hunter2-not-for-a-message}}}',
      }),
    );
    expect(directories[0]?.unreadable).toEqual([
      { file: "secrets.tf.json", reason: "The file is not valid JSON." },
    ]);
    expect(JSON.stringify(directories)).not.toContain("hunter2");
  });

  it("never looks inside tooling directories", async () => {
    const reader = tree(repository);
    await discoverTerraformDirectories(reader);
    expect(reader.reads.some((path) => /\.terraform|node_modules/.test(path))).toBe(false);
    expect(reader.reads).not.toContain("docs/notes.txt");
  });

  it("treats a repository that is one root as one root", async () => {
    const { roots } = await discoverTerraformRoots(
      tree({ "main.tf": 'resource "terraform_data" "x" {}', "modules/a/main.tf": "locals {}" }),
    );
    expect(roots.map((root) => root.path)).toEqual([""]);
  });

  it("stops at its limits and says it did", async () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 30; i++) wide[`d${i}/main.tf`] = 'resource "terraform_data" "x" {}';
    const capped = await discoverTerraformDirectories(tree(wide), { maxDirectories: 10 });
    expect(capped.truncated).toBe(true);
    expect(capped.directories.length).toBeLessThan(30);

    // Shared subtrees: every level lists the same two thousand names. Only
    // what will be walked is ever queued, so the walk asks for ten listings
    // and holds ten paths, not two thousand to the power of the depth.
    const names = Array.from({ length: 2000 }, (_, i) => `d${i}`);
    let listed = 0;
    const shared = await discoverTerraformDirectories(
      {
        list: async () => {
          listed += 1;
          return names.map((name) => ({ name, kind: "directory" as const }));
        },
        read: async () => null,
      },
      { maxDirectories: 10 },
    );
    expect(shared.truncated).toBe(true);
    expect(listed).toBe(10);

    const deep = await discoverTerraformDirectories(
      tree({ "a/b/c/d/main.tf": 'resource "terraform_data" "x" {}' }),
      { maxDepth: 2 },
    );
    expect(deep).toEqual({ directories: [], truncated: true });

    const big = await discoverTerraformDirectories(
      tree({ "main.tf": `resource "terraform_data" "x" {}\n${"#".repeat(2000)}` }),
      { maxFileBytes: 1000 },
    );
    expect(big.directories[0]?.unreadable[0]?.file).toBe("main.tf");
  });
});

describe("workspace names", () => {
  it("come from the root's path and never collide", () => {
    expect(suggestWorkspaceName("")).toBe("default");
    expect(suggestWorkspaceName("infra/envs/Prod")).toBe("infra-envs-prod");
    expect(suggestWorkspaceName("envs/prod", ["envs-prod", "envs-prod-2"])).toBe("envs-prod-3");
    expect(suggestWorkspaceName("_weird path/ü/")).toBe("weird-path");
    expect(isWorkspaceName(suggestWorkspaceName("a/".repeat(80)))).toBe(true);
    // A long run of dashes that is not at the end costs nothing.
    const started = performance.now();
    expect(suggestWorkspaceName(`a${"-".repeat(200_000)}b`)).toBe("a");
    expect(suggestWorkspaceName(`${"-".repeat(200_000)}`)).toBe("default");
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("are lowercase URL segments", () => {
    expect(isWorkspaceName("prod-eu_1")).toBe(true);
    for (const bad of ["", "Prod", "-prod", "a/b", "a b", "a.b", "x".repeat(64)]) {
      expect(isWorkspaceName(bad), bad).toBe(false);
    }
  });
});
