import { describe, expect, it } from "vitest";
import { deriveTerraformAttributeFieldMap, terraformAttributesToFields } from "@infrawrench/client-core";
import { plugin as aws } from "@infrawrench/plugin-aws";

import { literalAttributes, parseHclFile } from "../hcl-blocks.js";

/**
 * The derivation against a real plugin's mapper, end to end from HCL text to
 * the fields `estimateCost` reads: if the AWS mapper renames a field, this
 * is where a pull request check would silently stop pricing EC2.
 */
describe("attribute map against the AWS export mapper", () => {
  it("turns an aws_instance block into the create form's fields", () => {
    const map = deriveTerraformAttributeFieldMap(aws.terraformExport, "aws", "ec2-instance");
    expect(map.fieldByAttribute.get("instance_type")).toBe("instanceType");
    expect(map.fieldByAttribute.get("ami")).toBe("imageId");
    expect(map.attributes.has("tags")).toBe(true);

    const [block] = parseHclFile(
      `resource "aws_instance" "web" {\n  ami = "ami-0abc"\n  instance_type = "m6i.large"\n  subnet_id = var.subnet\n}\n`,
    ).resources;
    expect(terraformAttributesToFields(map, literalAttributes(block!))).toEqual({
      imageId: "ami-0abc",
      instanceType: "m6i.large",
    });
  });
});
