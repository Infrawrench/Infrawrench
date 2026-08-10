import { describe, expect, it } from "vitest";
import { resourceTypeDefinitionSchema } from "../validation/index.js";

const resourceTypeWith = (expiryFields: unknown) => ({
  id: "certificate",
  displayName: "Certificate",
  pluralDisplayName: "Certificates",
  description: "A TLS certificate",
  fields: [{ key: "notAfter", label: "Valid Until", kind: "string", required: false }],
  outputs: [],
  dashboardPinnable: true,
  expiryFields,
});

describe("expiryFields validation", () => {
  it("accepts an absolute-expiry rule", () => {
    const parsed = resourceTypeDefinitionSchema.safeParse(
      resourceTypeWith([
        { fieldKey: "notAfter", from: "expiry", kind: "tls-cert", label: "Certificate expires" },
      ]),
    );
    expect(parsed.success).toBe(true);
  });

  it("accepts an age-budget rule, with and without maxAgeDays", () => {
    for (const rule of [
      { fieldKey: "createdAt", from: "created", kind: "access-key", label: "Key age" },
      {
        fieldKey: "createdAt",
        from: "created",
        kind: "access-key",
        label: "Key age",
        maxAgeDays: 90,
      },
      {
        fieldKey: "lastRotatedDate",
        fallbackFieldKey: "createdDate",
        from: "created",
        kind: "secret-version",
        label: "Last rotated",
        maxAgeDays: 90,
      },
    ]) {
      expect(resourceTypeDefinitionSchema.safeParse(resourceTypeWith([rule])).success).toBe(true);
    }
  });

  it("rejects fallbackFieldKey on a from:'expiry' rule", () => {
    const parsed = resourceTypeDefinitionSchema.safeParse(
      resourceTypeWith([
        {
          fieldKey: "notAfter",
          from: "expiry",
          kind: "tls-cert",
          label: "Certificate expires",
          fallbackFieldKey: "createdDate",
        },
      ]),
    );
    expect(parsed.success).toBe(false);
  });

  // maxAgeDays on an absolute deadline is dead config — the author almost
  // certainly meant `from: "created"`, so the manifest must fail loudly.
  it("rejects maxAgeDays on a from:'expiry' rule", () => {
    const parsed = resourceTypeDefinitionSchema.safeParse(
      resourceTypeWith([
        {
          fieldKey: "notAfter",
          from: "expiry",
          kind: "tls-cert",
          label: "Certificate expires",
          maxAgeDays: 90,
        },
      ]),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown kinds, bad from values and empty keys/labels", () => {
    const bad = [
      { fieldKey: "notAfter", from: "expiry", kind: "certificate", label: "x" },
      { fieldKey: "notAfter", from: "expires", kind: "tls-cert", label: "x" },
      { fieldKey: "", from: "expiry", kind: "tls-cert", label: "x" },
      { fieldKey: "notAfter", from: "expiry", kind: "tls-cert", label: "" },
      { fieldKey: "notAfter", from: "created", kind: "tls-cert", label: "x", maxAgeDays: 0 },
      { fieldKey: "notAfter", from: "created", kind: "tls-cert", label: "x", maxAgeDays: 1.5 },
    ];
    for (const rule of bad) {
      expect(resourceTypeDefinitionSchema.safeParse(resourceTypeWith([rule])).success).toBe(false);
    }
  });
});
