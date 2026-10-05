import { describe, expect, it } from "vitest";
import {
  HclEditError,
  findResourceBlocks,
  parseLiteral,
  referencesResource,
  removeResourceBlock,
  setResourceAttribute,
  unifiedDiff,
} from "../github-issues/hcl";

const SRC = `# web tier
resource "aws_instance" "web" {
  ami           = "ami-123" # pinned
  instance_type = "m5.xlarge"
  tags = {
    Name = "web \${var.env}"
  }
  user_data = <<EOF
resource "aws_instance" "web" {
}
EOF
}

resource "aws_ebs_volume" "scratch" {
  size = 100
}

resource "aws_instance" "worker" {
  instance_type = var.worker_size
}
`;

describe("findResourceBlocks", () => {
  it("ignores lookalikes inside heredocs and finds the real block", () => {
    const blocks = findResourceBlocks(SRC, "aws_instance", "web");
    expect(blocks).toHaveLength(1);
    expect(SRC.slice(blocks[0]!.close, blocks[0]!.close + 1)).toBe("}");
    expect(SRC.slice(blocks[0]!.lineStart).startsWith('resource "aws_instance" "web"')).toBe(true);
  });
});

describe("setResourceAttribute", () => {
  it("changes only the literal, keeping the trailing comment and layout", () => {
    const { text, previous } = setResourceAttribute(SRC, "aws_instance", "web", "instance_type", {
      kind: "string",
      value: "m5.large",
    });
    expect(previous).toEqual({ kind: "string", value: "m5.xlarge" });
    expect(text).toContain('  instance_type = "m5.large"\n');
    expect(text.replace('"m5.large"', '"m5.xlarge"')).toBe(SRC);
    const ami = setResourceAttribute(SRC, "aws_instance", "web", "ami", {
      kind: "string",
      value: "ami-9",
    });
    expect(ami.text).toContain('ami           = "ami-9" # pinned');
  });

  it("edits numbers", () => {
    const { text } = setResourceAttribute(SRC, "aws_ebs_volume", "scratch", "size", {
      kind: "number",
      value: 50,
    });
    expect(text).toContain("  size = 50\n");
  });

  it("refuses expressions, missing attributes and missing blocks", () => {
    expect(() =>
      setResourceAttribute(SRC, "aws_instance", "worker", "instance_type", {
        kind: "string",
        value: "x",
      }),
    ).toThrow(/expression/);
    expect(() =>
      setResourceAttribute(SRC, "aws_instance", "web", "monitoring", {
        kind: "string",
        value: "x",
      }),
    ).toThrow(HclEditError);
    expect(() =>
      setResourceAttribute(SRC, "aws_instance", "nope", "x", { kind: "string", value: "x" }),
    ).toThrow(/No aws_instance.nope/);
  });

  it("does not touch a nested attribute of the same name", () => {
    expect(() =>
      setResourceAttribute(SRC, "aws_instance", "web", "Name", { kind: "string", value: "x" }),
    ).toThrow(/does not set Name/);
  });
});

describe("removeResourceBlock", () => {
  it("removes exactly the block and one blank line", () => {
    const out = removeResourceBlock(SRC, "aws_ebs_volume", "scratch");
    expect(out).not.toContain("aws_ebs_volume");
    expect(out).toContain('}\n\nresource "aws_instance" "worker"');
  });
});

describe("referencesResource", () => {
  it("finds references in code and interpolations but not comments", () => {
    expect(referencesResource("x = aws_ebs_volume.scratch.id\n", "aws_ebs_volume", "scratch")).toBe(
      true,
    );
    expect(
      referencesResource('x = "${aws_ebs_volume.scratch.id}"\n', "aws_ebs_volume", "scratch"),
    ).toBe(true);
    expect(referencesResource("# aws_ebs_volume.scratch\n", "aws_ebs_volume", "scratch")).toBe(
      false,
    );
  });
});

describe("parseLiteral", () => {
  it("accepts plain strings and numbers only", () => {
    expect(parseLiteral(' "a b" ')).toEqual({ kind: "string", value: "a b" });
    expect(parseLiteral("42")).toEqual({ kind: "number", value: 42 });
    expect(parseLiteral('"${var.x}"')).toBeNull();
    expect(parseLiteral("var.x")).toBeNull();
  });
});

describe("unifiedDiff", () => {
  it("renders a single hunk", () => {
    const diff = unifiedDiff("main.tf", "a\nb\nc\n", "a\nB\nc\n");
    expect(diff).toContain("-b\n+B");
    expect(diff.startsWith("--- a/main.tf\n+++ b/main.tf\n@@")).toBe(true);
  });
});
