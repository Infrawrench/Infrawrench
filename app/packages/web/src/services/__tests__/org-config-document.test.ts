import { describe, expect, it } from "vitest";

import {
  OrgConfigError,
  orgConfigDocumentSections,
  parseOrgConfigDocument,
} from "../org-config/schema";

/**
 * Document validation — the boundary between "a file someone hand-edited" and
 * anything the apply path is allowed to see. Pure: `schema.ts` deliberately
 * imports no database, so this runs without one.
 */

const minimal = { version: 1 };

describe("parseOrgConfigDocument", () => {
  it("accepts an empty document", () => {
    expect(parseOrgConfigDocument(minimal).version).toBe(1);
  });

  it("defaults the version so a hand-written file need not carry one", () => {
    expect(parseOrgConfigDocument({}).version).toBe(1);
  });

  it("refuses a document from a newer server rather than dropping what it can't read", () => {
    expect(() => parseOrgConfigDocument({ version: 99 })).toThrow(OrgConfigError);
    expect(() => parseOrgConfigDocument({ version: 99 })).toThrow(/understands up to/);
  });

  it("refuses unknown top-level keys, so a typo'd section is not silently ignored", () => {
    expect(() => parseOrgConfigDocument({ ...minimal, dashbords: [] })).toThrow(OrgConfigError);
  });

  it("refuses a key that isn't a slug", () => {
    expect(() =>
      parseOrgConfigDocument({
        ...minimal,
        budgets: [{ key: "Not A Slug", name: "x", amountCents: 1, thresholds: [] }],
      }),
    ).toThrow(/keys are lowercase/);
  });

  it("refuses duplicate keys within a section", () => {
    expect(() =>
      parseOrgConfigDocument({
        ...minimal,
        budgets: [
          {
            key: "spend",
            name: "A",
            amountCents: 100,
            thresholds: [{ type: "actual", percent: 80 }],
          },
          {
            key: "spend",
            name: "B",
            amountCents: 200,
            thresholds: [{ type: "actual", percent: 80 }],
          },
        ],
      }),
    ).toThrow(/Duplicate key "spend"/);
  });

  it("refuses two dashboards both claiming to be the default", () => {
    expect(() =>
      parseOrgConfigDocument({
        ...minimal,
        dashboards: [
          { key: "a", name: "A", isDefault: true },
          { key: "b", name: "B", isDefault: true },
        ],
      }),
    ).toThrow(/Only one dashboard can be the default/);
  });

  it("fills in the defaults an export omits", () => {
    const doc = parseOrgConfigDocument({
      ...minimal,
      workflows: [{ key: "nightly", name: "Nightly", source: "" }],
      dashboards: [{ key: "home", name: "Home" }],
    });
    expect(doc.workflows?.[0]).toMatchObject({
      trigger: { kind: "manual" },
      metrics: [],
      enabled: true,
    });
    expect(doc.dashboards?.[0]).toMatchObject({ isDefault: false, cards: [] });
  });

  it("keeps a budget trigger's reference as a key, never an id", () => {
    const doc = parseOrgConfigDocument({
      ...minimal,
      workflows: [
        {
          key: "on-overspend",
          name: "On overspend",
          source: "",
          trigger: { kind: "budget", budgetKey: "monthly-spend", percent: 90 },
        },
      ],
    });
    expect(doc.workflows?.[0]?.trigger).toEqual({
      kind: "budget",
      budgetKey: "monthly-spend",
      percent: 90,
    });
  });

  it("rejects a metric alert outside the documented bounds", () => {
    const rule = {
      key: "cpu",
      name: "CPU",
      metricKey: "CPU %",
      comparator: ">",
      threshold: 90,
      forMinutes: 1,
    };
    expect(() => parseOrgConfigDocument({ ...minimal, metricAlerts: [rule] })).toThrow(
      OrgConfigError,
    );
  });

  it("rejects an allocation rule whose tag value has no key", () => {
    expect(() =>
      parseOrgConfigDocument({
        ...minimal,
        costCentres: [
          {
            key: "platform",
            name: "Platform",
            rules: [{ priority: 0, match: { tagValue: "prod" } }],
          },
        ],
      }),
    ).toThrow(/tagValue requires tagKey/);
  });
});

describe("orgConfigDocumentSections", () => {
  it("reports only the sections the document carries", () => {
    const doc = parseOrgConfigDocument({
      ...minimal,
      budgets: [],
      tagPolicy: { requiredTags: [], enforceOnCreate: false },
    });
    expect(orgConfigDocumentSections(doc)).toEqual(["budgets", "tagPolicy"]);
  });

  it("counts an empty array as carried — that is what makes `replace` able to empty a section", () => {
    expect(orgConfigDocumentSections(parseOrgConfigDocument({ ...minimal, probes: [] }))).toEqual([
      "probes",
    ]);
  });

  it("reports nothing for a document with no sections", () => {
    expect(orgConfigDocumentSections(parseOrgConfigDocument(minimal))).toEqual([]);
  });
});
