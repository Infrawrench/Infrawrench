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
  validate,
} from "../validation/index.js";

describe("metric schemas", () => {
  it("metricSeriesPointSchema validates a point", () => {
    expect(validate(metricSeriesPointSchema, { timestamp: 1, value: 2 }).success).toBe(true);
    expect(validate(metricSeriesPointSchema, { timestamp: "x", value: 2 }).success).toBe(false);
  });

  it("metricSeriesSchema validates a series with optional unit", () => {
    expect(
      validate(metricSeriesSchema, {
        label: "CPU",
        unit: "%",
        points: [{ timestamp: 1, value: 50 }],
      }).success,
    ).toBe(true);
    expect(validate(metricSeriesSchema, { label: "CPU", points: [] }).success).toBe(true);
    expect(validate(metricSeriesSchema, { points: [] }).success).toBe(false);
  });
});

describe("query schemas", () => {
  it("queryCostEstimateSchema requires bytesProcessed", () => {
    expect(validate(queryCostEstimateSchema, { bytesProcessed: 100 }).success).toBe(true);
    expect(
      validate(queryCostEstimateSchema, {
        bytesProcessed: 100,
        estimatedCostUsd: 0.01,
        cacheHit: true,
        pricingNote: "n",
      }).success,
    ).toBe(true);
    expect(validate(queryCostEstimateSchema, {}).success).toBe(false);
  });

  it("queryResultSchema validates rows + durationMs", () => {
    expect(validate(queryResultSchema, { rows: [{ a: 1, b: "x" }], durationMs: 12 }).success).toBe(
      true,
    );
    expect(validate(queryResultSchema, { rows: [], durationMs: 0 }).success).toBe(true);
    expect(validate(queryResultSchema, { rows: "no", durationMs: 1 }).success).toBe(false);
  });

  it("queryExecuteResultSchema allows optional affectedRows", () => {
    expect(validate(queryExecuteResultSchema, {}).success).toBe(true);
    expect(validate(queryExecuteResultSchema, { affectedRows: 5 }).success).toBe(true);
    expect(validate(queryExecuteResultSchema, { affectedRows: "x" }).success).toBe(false);
  });
});

describe("pluginManifestSchema extra branches", () => {
  const base = {
    id: "x",
    displayName: "X",
    logoSvg: "<svg/>",
    egressHosts: [],
    credentialFields: [],
  };

  it("accepts rateLimit", () => {
    expect(
      validate(pluginManifestSchema, {
        ...base,
        rateLimit: { capacity: 10, refillPerSecond: 2 },
      }).success,
    ).toBe(true);
  });

  it("rejects non-positive rateLimit values", () => {
    expect(
      validate(pluginManifestSchema, { ...base, rateLimit: { capacity: 0, refillPerSecond: 2 } })
        .success,
    ).toBe(false);
  });

  it("accepts credentialFields with regions and accountReference", () => {
    expect(
      validate(pluginManifestSchema, {
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
      validate(pluginManifestSchema, {
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
      validate(resourceTypeDefinitionSchema, {
        ...base,
        attachTargets: [{ pluginId: "gcp", resourceTypeId: "gce-instance", matchField: "zone" }],
        supportsMetrics: true,
        iconKey: "server",
      }).success,
    ).toBe(true);
  });

  it("rejects secretExportTemplates with empty entries", () => {
    expect(
      validate(resourceTypeDefinitionSchema, {
        ...base,
        secretExportTemplates: [{ id: "e", displayName: "E", entries: [] }],
      }).success,
    ).toBe(false);
  });

  it("accepts peer integration unreachableWhen", () => {
    expect(
      validate(resourceTypeDefinitionSchema, {
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
      validate(resourceTypeDefinitionSchema, {
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
      validate(schemaNodeSchema, {
        kind: "metric-chart",
        title: "CPU",
        series: [{ label: "node", unit: "%", points: [{ timestamp: 1, value: 2 }] }],
        timeRangeLabel: "1h",
      }).success,
    ).toBe(true);
  });

  it("accepts grid nesting via lazy recursion", () => {
    expect(
      validate(schemaNodeSchema, {
        kind: "grid",
        columns: 3,
        items: [{ kind: "grid", columns: 1, items: [{ kind: "text", content: "x" }] }],
      }).success,
    ).toBe(true);
  });

  it("accepts reroll-parent-output and plugin-action host actions", () => {
    expect(
      validate(schemaNodeSchema, {
        kind: "action",
        label: "Reroll",
        action: { type: "reroll-parent-output", outputKey: "pw", confirmMessage: "sure?" },
      }).success,
    ).toBe(true);
    expect(
      validate(schemaNodeSchema, {
        kind: "action",
        label: "Run",
        action: { type: "plugin-action", actionId: "do-it", successMessage: "done" },
      }).success,
    ).toBe(true);
  });

  it("accepts prompt-nosql-command action", () => {
    expect(
      validate(schemaNodeSchema, {
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
    const result = validate(detailViewSchema, {
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
      validate(detailViewSchema, {
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
      validate(detailViewSchema, {
        title: "X",
        sections: [],
        noSqlBrowser: { driver: "couchdb", databaseLabel: "x" },
      }).success,
    ).toBe(false);
  });
});
