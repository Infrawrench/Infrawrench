import { describe, it, expect } from "vitest";
import {
  DEFAULT_RESOURCE_REPORT_CONFIG,
  RESOURCE_REPORT_LIMITS,
  buildResourceReportCsv,
  compareResourceReportCost,
  compareResourceReportText,
  dominantValues,
  parseProviderTimestamp,
  parseResourceReportColumn,
  primaryResourceReportCurrency,
  resourceCreatedFromFields,
  resourceFieldText,
  resourceRegionFromFields,
  resourceReportColumnLabel,
  resourceReportConfigError,
  resourceReportCostWindows,
  resourceReportCsvFilename,
  resourceReportFilterCount,
  resourceReportTagFilterMatches,
  resourceReportUsesCostData,
  resourceReportVirtualTagKeys,
  type ResourceReportColumn,
  type ResourceReportConfig,
  type ResourceReportRow,
} from "../resource-reports";

function config(patch: Partial<ResourceReportConfig> = {}): ResourceReportConfig {
  return { ...DEFAULT_RESOURCE_REPORT_CONFIG, ...patch };
}

describe("column ids", () => {
  it("parses every family and rejects unknown core and cost keys", () => {
    expect(parseResourceReportColumn("core:name")).toEqual({ kind: "core", key: "name" });
    expect(parseResourceReportColumn("field:instanceType")).toEqual({
      kind: "field",
      key: "instanceType",
    });
    // Keys may themselves contain colons (AWS tag keys do).
    expect(parseResourceReportColumn("tag:aws:cloudformation:stack-name")).toEqual({
      kind: "tag",
      key: "aws:cloudformation:stack-name",
    });
    expect(parseResourceReportColumn("cost:mtd")).toEqual({ kind: "cost", key: "mtd" });
    expect(parseResourceReportColumn("core:nope")).toBeNull();
    expect(parseResourceReportColumn("cost:yesterday")).toBeNull();
    expect(parseResourceReportColumn("bogus:x")).toBeNull();
    expect(parseResourceReportColumn("field:")).toBeNull();
    expect(parseResourceReportColumn("name")).toBeNull();
  });

  it("labels columns in English for the CLI and CSV", () => {
    expect(resourceReportColumnLabel("core:external_id")).toBe("Provider ID");
    expect(resourceReportColumnLabel("field:instanceType", "Instance Type")).toBe("Instance Type");
    expect(resourceReportColumnLabel("field:instanceType")).toBe("instanceType");
    expect(resourceReportColumnLabel("tag:env")).toBe("Tag: env");
    expect(resourceReportColumnLabel("vtag:team")).toBe("Virtual tag: team");
    expect(resourceReportColumnLabel("cost:previous_month")).toBe("Previous month");
  });
});

describe("resourceReportConfigError", () => {
  it("accepts the default config", () => {
    expect(resourceReportConfigError(DEFAULT_RESOURCE_REPORT_CONFIG)).toBeNull();
  });

  it("refuses empty, duplicate and unknown columns", () => {
    expect(resourceReportConfigError(config({ columns: [] }))).toMatch(/at least one column/);
    expect(resourceReportConfigError(config({ columns: ["core:name", "core:name"] }))).toMatch(
      /twice/,
    );
    expect(resourceReportConfigError(config({ columns: ["core:wat"] }))).toMatch(/not a column/);
    const many = Array.from(
      { length: RESOURCE_REPORT_LIMITS.maxColumns + 1 },
      (_, i) => `tag:k${i}`,
    );
    expect(resourceReportConfigError(config({ columns: many }))).toMatch(/At most/);
  });

  it("checks tag conditions against their operator", () => {
    const base = DEFAULT_RESOURCE_REPORT_CONFIG.filters;
    const withTag = (tag: ResourceReportConfig["filters"]["tags"][number]) =>
      config({ filters: { ...base, tags: [tag] } });
    expect(
      resourceReportConfigError(withTag({ source: "tag", key: "env", op: "in", values: [] })),
    ).toMatch(/at least one value/);
    expect(
      resourceReportConfigError(
        withTag({ source: "tag", key: "env", op: "exists", values: ["prod"] }),
      ),
    ).toMatch(/takes no values/);
    expect(
      resourceReportConfigError(withTag({ source: "tag", key: " ", op: "exists", values: [] })),
    ).toMatch(/needs a key/);
    expect(
      resourceReportConfigError(
        withTag({ source: "virtual_tag", key: "team", op: "in", values: ["a"] }),
      ),
    ).toBeNull();
  });

  it("caps virtual tags across columns and conditions", () => {
    const columns = ["core:name", "vtag:a", "vtag:b", "vtag:c", "vtag:d", "vtag:e"];
    expect(resourceReportConfigError(config({ columns }))).toBeNull();
    expect(
      resourceReportConfigError(
        config({
          columns,
          filters: {
            ...DEFAULT_RESOURCE_REPORT_CONFIG.filters,
            tags: [{ source: "virtual_tag", key: "f", op: "exists", values: [] }],
          },
        }),
      ),
    ).toMatch(/virtual tags/);
  });

  it("checks dates and the page size", () => {
    const filters = { ...DEFAULT_RESOURCE_REPORT_CONFIG.filters };
    expect(
      resourceReportConfigError(
        config({ filters: { ...filters, createdFrom: "2026-02-01", createdTo: "2026-01-01" } }),
      ),
    ).toMatch(/after/);
    expect(
      resourceReportConfigError(config({ filters: { ...filters, createdFrom: "yesterday" } })),
    ).toMatch(/not a date/);
    expect(
      resourceReportConfigError(
        config({ costRange: { kind: "absolute", from: "2026-03-01", to: "2026-02-01" } }),
      ),
    ).toMatch(/starts after/);
    expect(resourceReportConfigError(config({ pageSize: 0 }))).toMatch(/Rows per page/);
    expect(resourceReportConfigError(config({ pageSize: 501 }))).toMatch(/Rows per page/);
  });
});

describe("what a config needs", () => {
  it("collects virtual tag keys from columns, sort and conditions once each", () => {
    const c = config({
      columns: ["core:name", "vtag:team"],
      sort: { column: "vtag:env", direction: "asc" },
      filters: {
        ...DEFAULT_RESOURCE_REPORT_CONFIG.filters,
        tags: [
          { source: "virtual_tag", key: "team", op: "exists", values: [] },
          { source: "tag", key: "owner", op: "exists", values: [] },
        ],
      },
    });
    expect(resourceReportVirtualTagKeys(c).sort()).toEqual(["env", "team"]);
    expect(resourceReportUsesCostData(c)).toBe(true);
    expect(resourceReportUsesCostData(config({ columns: ["core:name", "tag:env"] }))).toBe(false);
    expect(
      resourceReportUsesCostData(
        config({ columns: ["core:name"], sort: { column: "cost:mtd", direction: "desc" } }),
      ),
    ).toBe(true);
  });

  it("counts set filters", () => {
    expect(resourceReportFilterCount(DEFAULT_RESOURCE_REPORT_CONFIG.filters)).toBe(0);
    expect(
      resourceReportFilterCount({
        ...DEFAULT_RESOURCE_REPORT_CONFIG.filters,
        pluginIds: ["aws"],
        nameContains: "web",
        createdTo: "2026-01-01",
        tags: [
          { source: "tag", key: "a", op: "exists", values: [] },
          { source: "tag", key: "b", op: "missing", values: [] },
        ],
      }),
    ).toBe(5);
  });
});

describe("reading stored records", () => {
  it("reads region from the first non-empty region key", () => {
    expect(resourceRegionFromFields({ region: " ", location: "westeurope" })).toBe("westeurope");
    expect(resourceRegionFromFields({ zone: "us-east1-b" })).toBe("us-east1-b");
    expect(resourceRegionFromFields({})).toBeNull();
    expect(resourceRegionFromFields(null)).toBeNull();
  });

  it("parses provider timestamps in the shapes plugins store", () => {
    expect(parseProviderTimestamp("2026-01-02T03:04:05Z")?.toISOString()).toBe(
      "2026-01-02T03:04:05.000Z",
    );
    expect(parseProviderTimestamp(1767225600)?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(parseProviderTimestamp(1767225600000)?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(parseProviderTimestamp("1767225600")?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(parseProviderTimestamp("May")).toBeNull();
    expect(parseProviderTimestamp("")).toBeNull();
    expect(parseProviderTimestamp(-5)).toBeNull();
  });

  it("takes the first created key that parses", () => {
    expect(resourceCreatedFromFields({ createdAt: "not a date", created_at: "2025-06-01" })).toBe(
      "2025-06-01T00:00:00.000Z",
    );
    expect(resourceCreatedFromFields({ name: "x" })).toBeNull();
  });

  it("prints field values as table text", () => {
    expect(resourceFieldText("t4g.small")).toBe("t4g.small");
    expect(resourceFieldText("")).toBeNull();
    expect(resourceFieldText(4)).toBe("4");
    expect(resourceFieldText(false)).toBe("false");
    expect(resourceFieldText(["a", "b", null])).toBe("a, b");
    expect(resourceFieldText({ a: 1 })).toBe('{"a":1}');
    expect(resourceFieldText(undefined)).toBeNull();
  });
});

describe("sorting", () => {
  it("sorts numbers by value, text naturally, empty last both ways", () => {
    const values = ["node-10", null, "node-2", "", "node-1"];
    const asc = [...values].sort((a, b) => compareResourceReportText(a, b, "asc"));
    expect(asc).toEqual(["node-1", "node-2", "node-10", null, ""]);
    const desc = [...values].sort((a, b) => compareResourceReportText(a, b, "desc"));
    expect(desc.slice(0, 3)).toEqual(["node-10", "node-2", "node-1"]);
    expect(desc.slice(3).every((v) => !v)).toBe(true);
    expect(compareResourceReportText("9", "10", "asc")).toBeLessThan(0);
  });

  it("sorts cost by the main currency, no spend as zero", () => {
    const usd = (amount: number) => [{ currency: "USD", amount }];
    const cells = [usd(5), [], usd(50), [{ currency: "EUR", amount: 1000 }]];
    expect(primaryResourceReportCurrency(cells)).toBe("EUR");
    expect(primaryResourceReportCurrency([usd(5), usd(50)])).toBe("USD");
    expect(primaryResourceReportCurrency([])).toBeNull();
    const sorted = [usd(5), [], usd(50)].sort((a, b) =>
      compareResourceReportCost(a, b, "USD", "desc"),
    );
    expect(sorted).toEqual([usd(50), usd(5), []]);
  });
});

describe("virtual tag values and tag conditions", () => {
  it("picks the value holding the most spend per resource, ignoring empty values", () => {
    const out = dominantValues([
      { key: "r1", value: "a", amount: 10 },
      { key: "r1", value: "b", amount: 30 },
      { key: "r1", value: "a", amount: 25 },
      { key: "r2", value: "", amount: 100 },
      { key: "r2", value: "z", amount: 1 },
      { key: "r3", value: "y", amount: 5 },
      { key: "r3", value: "x", amount: 5 },
    ]);
    expect(out.get("r1")).toBe("a");
    expect(out.get("r2")).toBe("z");
    expect(out.get("r3")).toBe("x");
  });

  it("matches each operator, treating a missing key as no value", () => {
    expect(resourceReportTagFilterMatches({ op: "exists", values: [] }, "")).toBe(true);
    expect(resourceReportTagFilterMatches({ op: "exists", values: [] }, null)).toBe(false);
    expect(resourceReportTagFilterMatches({ op: "missing", values: [] }, null)).toBe(true);
    expect(resourceReportTagFilterMatches({ op: "in", values: ["prod"] }, "prod")).toBe(true);
    expect(resourceReportTagFilterMatches({ op: "in", values: ["prod"] }, null)).toBe(false);
    expect(resourceReportTagFilterMatches({ op: "not_in", values: ["prod"] }, null)).toBe(true);
    expect(resourceReportTagFilterMatches({ op: "not_in", values: ["prod"] }, "prod")).toBe(false);
  });
});

describe("cost windows", () => {
  it("resolves month to date and the previous month in UTC", () => {
    const windows = resourceReportCostWindows(
      { from: "2026-02-15", to: "2026-03-14" },
      new Date("2026-03-14T12:00:00Z"),
    );
    expect(windows).toEqual([
      { window: "range", from: "2026-02-15", to: "2026-03-14" },
      { window: "mtd", from: "2026-03-01", to: "2026-03-14" },
      { window: "previous_month", from: "2026-02-01", to: "2026-02-28" },
    ]);
    const january = resourceReportCostWindows(
      { from: "2026-01-01", to: "2026-01-05" },
      new Date("2026-01-05T00:00:00Z"),
    );
    expect(january[2]).toEqual({ window: "previous_month", from: "2025-12-01", to: "2025-12-31" });
  });
});

describe("CSV", () => {
  const columns: ResourceReportColumn[] = [
    { id: "core:name", kind: "core", key: "name", label: "Name" },
    { id: "tag:env", kind: "tag", key: "env", label: "Tag: env" },
    { id: "cost:range", kind: "cost", key: "range", label: "Accrued cost" },
  ];
  const row = (id: string, name: string, env: string | null, costs: ResourceReportRow["costs"]) =>
    ({
      id,
      accountId: "acct",
      pluginId: "aws",
      resourceTypeId: "ec2",
      values: { "core:name": name, "tag:env": env },
      costs,
    }) satisfies ResourceReportRow;

  it("writes one numeric column per cost currency and traces rows back", () => {
    const csv = buildResourceReportCsv(columns, [
      row("r1", "web, primary", "prod", { "cost:range": [{ currency: "USD", amount: 12.5 }] }),
      row("r2", 'say "hi"', null, {
        "cost:range": [
          { currency: "EUR", amount: 3 },
          { currency: "USD", amount: 1 },
        ],
      }),
      row("r3", "idle", "dev", { "cost:range": [] }),
    ]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "Name,Tag: env,Accrued cost (EUR),Accrued cost (USD),Resource ID,Account ID",
    );
    expect(lines[1]).toBe('"web, primary",prod,0,12.5,r1,acct');
    expect(lines[2]).toBe('"say ""hi""",,3,1,r2,acct');
    expect(lines[3]).toBe("idle,dev,0,0,r3,acct");
  });

  it("keeps a cost column when nothing had spend, and defuses formulas", () => {
    const csv = buildResourceReportCsv(columns, [
      row("r1", "=HYPERLINK(1)", "-x", { "cost:range": [] }),
    ]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("Name,Tag: env,Accrued cost,Resource ID,Account ID");
    expect(lines[1]).toBe("'=HYPERLINK(1),'-x,,r1,acct");
  });

  it("names the file after the report", () => {
    expect(resourceReportCsvFilename("Prod EC2 / by team!", new Date("2026-10-16T00:00:00Z"))).toBe(
      "prod-ec2-by-team-2026-10-16.csv",
    );
    expect(resourceReportCsvFilename("!!!", new Date("2026-10-16T00:00:00Z"))).toBe(
      "resource-report-2026-10-16.csv",
    );
  });
});
