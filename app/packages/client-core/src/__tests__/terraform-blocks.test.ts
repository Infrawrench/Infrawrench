import { describe, expect, it } from "vitest";
import type { IacReconciliationEntry, IacReconciliationResponse } from "../iac";
import {
  buildIacAddressIndex,
  findTerraformResourceBlocks,
  lookupTerraformBlock,
  parseTerraformAddress,
} from "../iac";

describe("findTerraformResourceBlocks", () => {
  it("finds headers and skips comments and heredocs", () => {
    const text = [
      'resource "aws_instance" "web" {',
      "  ami = var.ami",
      "}",
      '# resource "aws_instance" "commented" {',
      "/*",
      'resource "aws_instance" "in_block_comment" {',
      "*/",
      'data "aws_ami" "ubuntu" {',
      "}",
      "locals {",
      "  script = <<-EOT",
      'resource "aws_instance" "in_heredoc" {',
      "  EOT",
      "}",
      '  resource "aws_s3_bucket" "logs" {',
    ].join("\n");
    const blocks = findTerraformResourceBlocks(text);
    expect(blocks.map((b) => [b.address, b.line, b.startColumn])).toEqual([
      ["aws_instance.web", 0, 0],
      ["aws_s3_bucket.logs", 14, 2],
    ]);
  });
});

describe("parseTerraformAddress", () => {
  it("splits module paths and instance keys", () => {
    expect(parseTerraformAddress("aws_instance.web")).toEqual({
      modulePath: "",
      terraformType: "aws_instance",
      name: "web",
      instanceKey: "",
    });
    expect(parseTerraformAddress('module.net["eu.west"].aws_subnet.private["a.b"]')).toEqual({
      modulePath: 'module.net["eu.west"]',
      terraformType: "aws_subnet",
      name: "private",
      instanceKey: '["a.b"]',
    });
    expect(parseTerraformAddress("aws_instance.web[2]")?.instanceKey).toBe("[2]");
  });

  it("rejects data sources", () => {
    expect(parseTerraformAddress("data.aws_ami.ubuntu")).toBeNull();
    expect(parseTerraformAddress("module.a.data.aws_ami.ubuntu")).toBeNull();
  });
});

function entry(id: string, address: string | null): IacReconciliationEntry {
  return {
    resourceId: id,
    pluginId: "aws",
    resourceTypeId: "ec2-instance",
    accountId: "acc",
    displayName: id,
    externalId: `ext-${id}`,
    status: address ? "managed" : "unmanaged",
    terraformType: "aws_instance",
    terraformAddress: address,
    matchedBy: address ? "external-id" : null,
    drift: [],
    unmappableReason: null,
    owner: null,
    firstSeenAt: null,
  };
}

describe("buildIacAddressIndex", () => {
  it("indexes every module instance under the block address, root first", () => {
    const rec = {
      state: { id: "s1", label: "prod" },
      resources: [
        entry("a", "module.app.aws_instance.web"),
        entry("b", "aws_instance.web[0]"),
        entry("c", null),
        entry("d", "aws_instance.other"),
      ],
    } as unknown as IacReconciliationResponse;
    const index = buildIacAddressIndex([rec]);
    const matches = lookupTerraformBlock(index, { address: "aws_instance.web" });
    expect(matches.map((m) => m.resource.resourceId)).toEqual(["b", "a"]);
    expect(matches[0]!.state.label).toBe("prod");
    expect(lookupTerraformBlock(index, { address: "aws_instance.none" })).toEqual([]);
  });
});
