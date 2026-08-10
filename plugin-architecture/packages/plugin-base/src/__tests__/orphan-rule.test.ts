import { describe, expect, it } from "vitest";
import { evaluateOrphanRule, type OrphanRule } from "../resource.js";
import { resourceTypeDefinitionSchema } from "../validation/index.js";

const unattachedVolume: OrphanRule = {
  conditions: [{ fieldKey: "attachedTo", when: "empty" }],
  reason: "Volume is not attached to any server",
};

describe("evaluateOrphanRule", () => {
  it("returns null when no rule is declared", () => {
    expect(evaluateOrphanRule(undefined, { attachedTo: "" })).toBeNull();
  });

  it("returns null when the rule has no conditions", () => {
    expect(evaluateOrphanRule({ conditions: [], reason: "x" }, {})).toBeNull();
  });

  it("flags empty-string and absent fields as empty", () => {
    expect(evaluateOrphanRule(unattachedVolume, { attachedTo: "" })).toBe(
      "Volume is not attached to any server",
    );
    expect(evaluateOrphanRule(unattachedVolume, {})).toBe("Volume is not attached to any server");
    expect(evaluateOrphanRule(unattachedVolume, undefined)).toBe(
      "Volume is not attached to any server",
    );
  });

  it("does not treat 0 or false as empty — a real value is a real value", () => {
    expect(evaluateOrphanRule(unattachedVolume, { attachedTo: 0 })).toBeNull();
    expect(evaluateOrphanRule(unattachedVolume, { attachedTo: false })).toBeNull();
  });

  it("compares equals case-insensitively and stringifies numbers", () => {
    const rule: OrphanRule = {
      conditions: [{ fieldKey: "status", when: "equals", value: "reserved" }],
      reason: "Static IP is reserved but not in use",
    };
    expect(evaluateOrphanRule(rule, { status: "RESERVED" })).toBe(
      "Static IP is reserved but not in use",
    );
    expect(evaluateOrphanRule(rule, { status: "IN_USE" })).toBeNull();
    const numeric: OrphanRule = {
      conditions: [{ fieldKey: "attachmentCount", when: "equals", value: "0" }],
      reason: "No attachments",
    };
    expect(evaluateOrphanRule(numeric, { attachmentCount: 0 })).toBe("No attachments");
  });

  it("never matches equals/notEquals against an absent field", () => {
    const eq: OrphanRule = {
      conditions: [{ fieldKey: "status", when: "equals", value: "reserved" }],
      reason: "r",
    };
    const neq: OrphanRule = {
      conditions: [{ fieldKey: "status", when: "notEquals", value: "in-use" }],
      reason: "r",
    };
    expect(evaluateOrphanRule(eq, {})).toBeNull();
    expect(evaluateOrphanRule(neq, {})).toBeNull();
  });

  it("requires all conditions to hold", () => {
    const rule: OrphanRule = {
      conditions: [
        { fieldKey: "instanceId", when: "empty" },
        { fieldKey: "domain", when: "equals", value: "vpc" },
      ],
      reason: "Elastic IP is not associated with an instance",
    };
    expect(evaluateOrphanRule(rule, { instanceId: "", domain: "vpc" })).toBe(
      "Elastic IP is not associated with an instance",
    );
    expect(evaluateOrphanRule(rule, { instanceId: "i-123", domain: "vpc" })).toBeNull();
    expect(evaluateOrphanRule(rule, { instanceId: "", domain: "standard" })).toBeNull();
  });
});

const resourceTypeWith = (orphanRule: unknown) => ({
  id: "volume",
  displayName: "Volume",
  pluralDisplayName: "Volumes",
  description: "A block storage volume",
  fields: [{ key: "name", label: "Name", kind: "string", required: true }],
  outputs: [],
  dashboardPinnable: true,
  orphanRule,
});

describe("orphanRule validation", () => {
  it("accepts an `empty` condition with no value", () => {
    expect(resourceTypeDefinitionSchema.safeParse(resourceTypeWith(unattachedVolume)).success).toBe(
      true,
    );
  });

  it("accepts `equals` / `notEquals` when value is present", () => {
    for (const when of ["equals", "notEquals"] as const) {
      const parsed = resourceTypeDefinitionSchema.safeParse(
        resourceTypeWith({
          conditions: [{ fieldKey: "status", when, value: "available" }],
          reason: "r",
        }),
      );
      expect(parsed.success).toBe(true);
    }
  });

  // Without this, a forgotten `value` silently compares against "" at runtime
  // rather than failing manifest validation.
  it("rejects `equals` / `notEquals` with no value", () => {
    for (const when of ["equals", "notEquals"] as const) {
      const parsed = resourceTypeDefinitionSchema.safeParse(
        resourceTypeWith({ conditions: [{ fieldKey: "status", when }], reason: "r" }),
      );
      expect(parsed.success).toBe(false);
    }
  });

  it("accepts an explicit empty-string value for `equals`", () => {
    const parsed = resourceTypeDefinitionSchema.safeParse(
      resourceTypeWith({
        conditions: [{ fieldKey: "users", when: "equals", value: "" }],
        reason: "r",
      }),
    );
    expect(parsed.success).toBe(true);
  });
});
