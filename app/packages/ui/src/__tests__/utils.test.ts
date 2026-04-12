import { describe, expect, it } from "vitest";
import { humanizeIdentifier } from "../utils";

describe("humanizeIdentifier", () => {
  it("humanizes camelCase values", () => {
    expect(humanizeIdentifier("resourceTypeId")).toBe("Resource Type Id");
  });

  it("humanizes snake_case and kebab-case values", () => {
    expect(humanizeIdentifier("resource_type_id")).toBe("Resource Type Id");
    expect(humanizeIdentifier("resource-type-id")).toBe("Resource Type Id");
  });

  it("preserves acronyms while splitting mixed case", () => {
    expect(humanizeIdentifier("AWSRdsInstance")).toBe("AWS Rds Instance");
  });

  it("returns empty string for whitespace-only values", () => {
    expect(humanizeIdentifier("   ")).toBe("");
  });
});
