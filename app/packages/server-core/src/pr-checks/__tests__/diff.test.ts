import { describe, expect, it } from "vitest";

import { diffInfrastructureFiles } from "../diff.js";
import { blockCount, changedAttributes, parseHclFile, parseAttributeValue } from "../hcl-blocks.js";

const BASE = `
# The web tier
resource "aws_instance" "web" {
  ami           = "ami-123"
  instance_type = "t3.large" # sized for launch
  count         = 2
  tags = {
    Name = "web"
    team = "growth"
  }

  root_block_device {
    volume_size = 40
  }
}

resource "aws_s3_bucket" "logs" {
  bucket = "acme-logs"
}

module "network" {
  source = "./network"
}
`;

describe("parseHclFile", () => {
  it("reads resource blocks, literals, maps and nested blocks", () => {
    const parsed = parseHclFile(BASE);
    expect(parsed.errors).toEqual([]);
    expect(parsed.modules).toEqual([{ name: "network", line: 21 }]);
    const web = parsed.resources.find((r) => r.address === "aws_instance.web")!;
    expect(web.line).toBe(3);
    expect(web.attributes["instance_type"]).toEqual({
      kind: "string",
      value: "t3.large",
      raw: '"t3.large"',
    });
    expect(web.attributes["count"]).toMatchObject({ kind: "number", value: 2 });
    expect(web.attributes["tags"]).toMatchObject({
      kind: "map",
      entries: { Name: "web", team: "growth" },
    });
    expect(web.nestedBlocks["root_block_device"]).toContain("volume_size = 40");
    expect(blockCount(web)).toBe(2);
  });

  it("treats expressions as opaque and never evaluates them", () => {
    expect(parseAttributeValue("var.size")).toEqual({ kind: "expression", raw: "var.size" });
    expect(parseAttributeValue('merge(local.tags, { a = "b" })').kind).toBe("expression");
    expect(parseAttributeValue("{ a = var.x }").kind).toBe("expression");
    expect(parseAttributeValue("true")).toMatchObject({ kind: "bool", value: true });
  });

  it("ignores braces inside strings, heredocs and comments", () => {
    const src = `
resource "x_thing" "a" {
  script = <<EOF
resource "fake" "block" {
EOF
  note = "has } and { inside"
  // resource "commented" "out" {
}
`;
    const parsed = parseHclFile(src);
    expect(parsed.resources.map((r) => r.address)).toEqual(["x_thing.a"]);
    expect(parsed.resources[0]!.attributes["note"]).toMatchObject({ value: "has } and { inside" });
  });

  it("reports for_each as an unknown count", () => {
    const parsed = parseHclFile(`resource "a_b" "c" {\n  for_each = toset(["x"])\n}\n`);
    expect(blockCount(parsed.resources[0]!)).toBeNull();
  });

  it("does not treat reformatting as a change", () => {
    const a = parseHclFile(`resource "a_b" "c" {\n  size = "big"\n}\n`).resources[0]!;
    const b = parseHclFile(`resource "a_b" "c" {\n  size     =    "big"   # comment\n}\n`)
      .resources[0]!;
    expect(changedAttributes(a, b)).toEqual([]);
  });
});

describe("diffInfrastructureFiles", () => {
  it("classifies creates, updates and deletes per module directory", () => {
    const head = BASE.replace('"t3.large"', '"t3.xlarge"').replace(
      'resource "aws_s3_bucket" "logs" {\n  bucket = "acme-logs"\n}\n',
      'resource "aws_db_instance" "main" {\n  instance_class = "db.t3.micro"\n}\n',
    );
    const diff = diffInfrastructureFiles([{ path: "infra/main.tf", before: BASE, after: head }]);
    expect(diff.files).toEqual([
      { path: "infra/main.tf", kind: "terraform", status: "modified", analysed: true, note: null },
    ]);
    const byAddress = Object.fromEntries(diff.changes.map((c) => [c.address, c]));
    expect(byAddress["aws_instance.web"]).toMatchObject({
      action: "update",
      changedAttributes: ["instance_type"],
      directory: "infra",
    });
    expect(byAddress["aws_db_instance.main"]).toMatchObject({ action: "create", line: 17 });
    expect(byAddress["aws_s3_bucket.logs"]).toMatchObject({ action: "delete", line: null });
    expect(diff.notes.some((n) => n.includes("Module calls"))).toBe(true);
  });

  it("does not report a block moved between files of the same module", () => {
    const block = 'resource "aws_s3_bucket" "logs" {\n  bucket = "acme-logs"\n}\n';
    const diff = diffInfrastructureFiles([
      { path: "infra/a.tf", before: block, after: "" },
      { path: "infra/b.tf", before: null, after: block },
    ]);
    expect(diff.changes).toEqual([]);
  });

  it("turns a moved block into an update of the renamed address", () => {
    const before = 'resource "aws_s3_bucket" "old" {\n  bucket = "x"\n}\n';
    const after =
      'resource "aws_s3_bucket" "new" {\n  bucket = "x"\n}\n\nmoved {\n  from = aws_s3_bucket.old\n  to   = aws_s3_bucket.new\n}\n';
    const diff = diffInfrastructureFiles([{ path: "main.tf", before, after }]);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({
      action: "update",
      address: "aws_s3_bucket.new",
      movedFrom: "aws_s3_bucket.old",
      changedAttributes: [],
    });
  });

  it("lists Infrafiles and manifests without analysing them, and honours directories", () => {
    const manifest = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n";
    const diff = diffInfrastructureFiles(
      [
        { path: "Infrafile", before: "a", after: "b" },
        { path: "k8s/web.yaml", before: null, after: manifest },
        { path: "k8s/values.yaml", before: null, after: "replicas: 3\n" },
        { path: "other/main.tf", before: null, after: 'resource "a_b" "c" {}\n' },
      ],
      ["k8s", ""],
    );
    expect(diff.files.map((f) => [f.path, f.kind, f.analysed])).toEqual([
      ["Infrafile", "infrafile", false],
      ["k8s/web.yaml", "kubernetes", false],
      ["other/main.tf", "terraform", true],
    ]);
    const scoped = diffInfrastructureFiles(
      [{ path: "other/main.tf", before: null, after: 'resource "a_b" "c" {}\n' }],
      ["k8s"],
    );
    expect(scoped.files).toEqual([]);
  });
});
