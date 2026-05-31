import { describe, it, expect } from "vitest";
import {
  pluginManifestSchema,
  resourceTypeDefinitionSchema,
  schemaNodeSchema,
  detailViewSchema,
  metricSeriesSchema,
  metricSeriesPointSchema,
  queryCostEstimateSchema,
  queryResultSchema,
  queryExecuteResultSchema,
} from "../validation/index.js";

describe("metric schemas", () => {
  it("metricSeriesPointSchema validates a point", () => {
    expect(metricSeriesPointSchema.safeParse({ timestamp: 1, value: 2 }).success).toBe(true);
    expect(metricSeriesPointSchema.safeParse({ timestamp: "x", value: 2 }).success).toBe(false);
  });

  it("metricSeriesSchema validates a series with optional unit", () => {
    expect(
      metricSeriesSchema.safeParse({
        label: "CPU",
        unit: "%",
        points: [{ timestamp: 1, value: 50 }],
      }).success,
    ).toBe(true);
    expect(metricSeriesSchema.safeParse({ label: "CPU", points: [] }).success).toBe(true);
    expect(metricSeriesSchema.safeParse({ points: [] }).success).toBe(false);
  });
});

describe("query schemas", () => {
  it("queryCostEstimateSchema requires bytesProcessed", () => {
    expect(queryCostEstimateSchema.safeParse({ bytesProcessed: 100 }).success).toBe(true);
    expect(
      queryCostEstimateSchema.safeParse({
        bytesProcessed: 100,
        estimatedCostUsd: 0.01,
        cacheHit: true,
        pricingNote: "n",
      }).success,
    ).toBe(true);
    expect(queryCostEstimateSchema.safeParse({}).success).toBe(false);
  });

  it("queryResultSchema validates rows + durationMs", () => {
    expect(queryResultSchema.safeParse({ rows: [{ a: 1, b: "x" }], durationMs: 12 }).success).toBe(
      true,
    );
    expect(queryResultSchema.safeParse({ rows: [], durationMs: 0 }).success).toBe(true);
    expect(queryResultSchema.safeParse({ rows: "no", durationMs: 1 }).success).toBe(false);
  });

  it("queryExecuteResultSchema allows optional affectedRows", () => {
    expect(queryExecuteResultSchema.safeParse({}).success).toBe(true);
    expect(queryExecuteResultSchema.safeParse({ affectedRows: 5 }).success).toBe(true);
    expect(queryExecuteResultSchema.safeParse({ affectedRows: "x" }).success).toBe(false);
  });
});

describe("pluginManifestSchema extra branches", () => {
  const base = {
    id: "x",
    version: "1.0.0",
    displayName: "X",
    logoSvg: "<svg/>",
    author: "me",
    minHostVersion: "0.1.0",
  };

  it("accepts rateLimit", () => {
    expect(
      pluginManifestSchema.safeParse({
        ...base,
        rateLimit: { capacity: 10, refillPerSecond: 2 },
      }).success,
    ).toBe(true);
  });

  it("rejects non-positive rateLimit values", () => {
    expect(
      pluginManifestSchema.safeParse({ ...base, rateLimit: { capacity: 0, refillPerSecond: 2 } })
        .success,
    ).toBe(false);
  });

  it("accepts credentialFields with regions and accountReference", () => {
    expect(
      pluginManifestSchema.safeParse({
        ...base,
        credentialFields: [
          {
            key: "region",
            label: "Region",
            sensitive: false,
            regions: [{ id: "nyc3", label: "New York", location: "US", flag: "🇺🇸" }],
            accountReference: { pluginId: "aws" },
            optional: true,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects empty accountReference pluginId", () => {
    expect(
      pluginManifestSchema.safeParse({
        ...base,
        credentialFields: [
          { key: "k", label: "L", sensitive: false, accountReference: { pluginId: "" } },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("resourceTypeDefinitionSchema extra branches", () => {
  const base = {
    id: "t",
    displayName: "T",
    pluralDisplayName: "Ts",
    description: "d",
    fields: [],
    outputs: [],
    dashboardPinnable: false,
  };

  it("accepts attachTargets and supportsMetrics", () => {
    expect(
      resourceTypeDefinitionSchema.safeParse({
        ...base,
        attachTargets: [{ pluginId: "gcp", resourceTypeId: "gce-instance", matchField: "zone" }],
        supportsMetrics: true,
        iconKey: "server",
      }).success,
    ).toBe(true);
  });

  it("rejects secretExportTemplates with empty entries", () => {
    expect(
      resourceTypeDefinitionSchema.safeParse({
        ...base,
        secretExportTemplates: [{ id: "e", displayName: "E", entries: [] }],
      }).success,
    ).toBe(false);
  });

  it("accepts peer integration unreachableWhen", () => {
    expect(
      resourceTypeDefinitionSchema.safeParse({
        ...base,
        peerIntegrations: [
          {
            pluginId: "postgres",
            credentialMappings: [{ outputKey: "o", credentialKey: "c" }],
            tabLabel: "SQL",
            unreachableWhen: { fieldsEmpty: ["publicIp"], title: "t", suggestions: ["s"] },
            exposeMetricsToParent: true,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects unreachableWhen with empty fieldsEmpty", () => {
    expect(
      resourceTypeDefinitionSchema.safeParse({
        ...base,
        peerIntegrations: [
          {
            pluginId: "p",
            credentialMappings: [],
            tabLabel: "T",
            unreachableWhen: { fieldsEmpty: [], title: "t", suggestions: [] },
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("schemaNodeSchema additional node kinds", () => {
  it("accepts metric-chart node", () => {
    expect(
      schemaNodeSchema.safeParse({
        kind: "metric-chart",
        title: "CPU",
        series: [{ label: "node", unit: "%", points: [{ timestamp: 1, value: 2 }] }],
        timeRangeLabel: "1h",
      }).success,
    ).toBe(true);
  });

  it("accepts grid nesting via lazy recursion", () => {
    expect(
      schemaNodeSchema.safeParse({
        kind: "grid",
        columns: 3,
        items: [{ kind: "grid", columns: 1, items: [{ kind: "text", content: "x" }] }],
      }).success,
    ).toBe(true);
  });

  it("accepts reroll-parent-output and plugin-action host actions", () => {
    expect(
      schemaNodeSchema.safeParse({
        kind: "action",
        label: "Reroll",
        action: { type: "reroll-parent-output", outputKey: "pw", confirmMessage: "sure?" },
      }).success,
    ).toBe(true);
    expect(
      schemaNodeSchema.safeParse({
        kind: "action",
        label: "Run",
        action: { type: "plugin-action", actionId: "do-it", successMessage: "done" },
      }).success,
    ).toBe(true);
  });

  it("accepts prompt-nosql-command action", () => {
    expect(
      schemaNodeSchema.safeParse({
        kind: "action",
        label: "Create user",
        action: {
          type: "prompt-nosql-command",
          command: "createUser",
          title: "New user",
          fields: [{ key: "name", label: "Name", kind: "text", required: true }],
          danger: false,
        },
      }).success,
    ).toBe(true);
  });
});

describe("detailViewSchema additional branches", () => {
  it("accepts childTables, childGroups, settingsEditor, metricsCapability, noSqlBrowser, customTabs", () => {
    const childTable = {
      title: "Records",
      typeId: "dns-record",
      columns: [
        {
          key: "type",
          label: "Type",
          width: "narrow",
          source: { kind: "field", fieldKey: "type" },
          format: "type-badge",
        },
        { key: "name", label: "Name", source: { kind: "display-name" } },
        { key: "id", label: "ID", source: { kind: "external-id" } },
      ],
      onRowClick: "navigate",
      readOnlyRowWhen: { fieldKey: "managed", fieldValues: ["true"] },
    };
    const result = detailViewSchema.safeParse({
      title: "Zone",
      sections: [],
      childGroups: [
        {
          title: "Records",
          items: [
            { pluginId: "cf", resourceTypeId: "dns-record", resourceId: "r1", displayName: "a" },
          ],
          createLabel: "Add",
          emptyText: "none",
        },
      ],
      childTables: [childTable],
      settingsEditor: { tabLabel: "Settings", description: "d" },
      metricsCapability: { defaultTimeRangeMs: 3600000 },
      noSqlBrowser: { driver: "firestore", databaseLabel: "(default)", singleCollection: false },
      customTabs: [
        {
          id: "tab1",
          label: "Tab 1",
          sections: [{ kind: "section", children: [] }],
          childTables: [childTable],
          childResourceTypeIds: ["dns-record"],
          headerActions: [
            { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects childTable with invalid format", () => {
    expect(
      detailViewSchema.safeParse({
        title: "X",
        sections: [],
        childTables: [
          {
            title: "T",
            typeId: "t",
            columns: [
              { key: "k", label: "L", source: { kind: "field", fieldKey: "f" }, format: "nope" },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects noSqlBrowser with unknown driver", () => {
    expect(
      detailViewSchema.safeParse({
        title: "X",
        sections: [],
        noSqlBrowser: { driver: "couchdb", databaseLabel: "x" },
      }).success,
    ).toBe(false);
  });
});
