import { describe, it, expect } from "vitest";
import { dnsContentField, PICKABLE_DNS_TYPES } from "../dns-helpers.js";

describe("dns-helpers constants", () => {
  it("PICKABLE_DNS_TYPES contains A/AAAA/CNAME", () => {
    expect([...PICKABLE_DNS_TYPES]).toEqual(["A", "AAAA", "CNAME"]);
  });
});

describe("dnsContentField", () => {
  it("builds mode toggle + 3 pickers + text input with defaults", () => {
    const fields = dnsContentField({ key: "content" });
    expect(fields).toHaveLength(5);

    const mode = fields[0]!;
    const aPicker = fields[1]!;
    const aaaaPicker = fields[2]!;
    const cnamePicker = fields[3]!;
    const text = fields[4]!;

    expect(mode.key).toBe("content__mode");
    expect(mode.kind).toBe("select");
    expect(mode.transient).toBe(true);
    expect(mode.defaultValue).toBe("picker");
    expect(mode.showWhen).toEqual({ fieldKey: "type", fieldValues: ["A", "AAAA", "CNAME"] });

    expect(aPicker.kind).toBe("resource-picker");
    expect(aPicker.key).toBe("content");
    expect(aPicker.referenceMode).toBe(true);
    expect(aPicker.associationRole).toBe("dns-ipv4");
    expect(aPicker.showWhen).toEqual({
      allOf: [
        { fieldKey: "type", fieldValue: "A" },
        { fieldKey: "content__mode", fieldValue: "picker" },
      ],
    });

    expect(aaaaPicker.associationRole).toBe("dns-ipv6");
    expect(cnamePicker.associationRole).toBe("dns-hostname");

    expect(text.kind).toBe("text");
    expect(text.key).toBe("content");
    expect(text.required).toBe(true);
    expect(text.showWhen).toEqual({
      anyOf: [
        { fieldKey: "content__mode", fieldValue: "custom" },
        { fieldKey: "type", fieldValuesNot: ["A", "AAAA", "CNAME"] },
      ],
    });
  });

  it("honors custom label, required=false, recordTypeFieldKey", () => {
    const fields = dnsContentField({
      key: "data",
      label: "Data",
      required: false,
      recordTypeFieldKey: "recordType",
    });
    const mode = fields[0]!;
    const aPicker = fields[1]!;
    expect(mode.key).toBe("data__mode");
    expect(mode.showWhen).toEqual({
      fieldKey: "recordType",
      fieldValues: ["A", "AAAA", "CNAME"],
    });
    expect(aPicker.required).toBe(false);
    expect(aPicker.label).toContain("Data");
    expect(aPicker.showWhen).toEqual({
      allOf: [
        { fieldKey: "recordType", fieldValue: "A" },
        { fieldKey: "data__mode", fieldValue: "picker" },
      ],
    });
  });

  it("omits placeholder/description on text input when not given", () => {
    const fields = dnsContentField({ key: "value" });
    const text = fields[4]!;
    expect("placeholder" in text).toBe(false);
    expect("description" in text).toBe(false);
  });

  it("includes placeholder and description on text input when given", () => {
    const fields = dnsContentField({
      key: "value",
      placeholder: "1.2.3.4",
      description: "An IP",
    });
    const text = fields[4]!;
    expect(text.placeholder).toBe("1.2.3.4");
    expect(text.description).toBe("An IP");
  });
});
