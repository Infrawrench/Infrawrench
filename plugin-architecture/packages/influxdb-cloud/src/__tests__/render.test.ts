import type { ResourceInstance } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { renderInfluxDetail } from "../render.js";
import { T } from "../resource-types.js";

function bucket(resolvedOutputs: Record<string, string> = {}): ResourceInstance {
  return {
    id: "res-1",
    pluginId: "influxdb-cloud",
    resourceTypeId: T.bucket,
    accountId: "acc",
    displayName: "metrics",
    fields: { bucketId: "b1", retentionDays: 30 },
    resolvedOutputs,
    secretStates: [],
    externalId: "b1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("renderInfluxDetail", () => {
  it("turns on the query editor for a bucket", () => {
    const schema = renderInfluxDetail(bucket());
    expect(schema.sqlEditor).toEqual({
      connectionStringOutputKey: "bucketId",
      defaultQuery: "SHOW MEASUREMENTS",
      tables: [],
      queryLanguage: "InfluxQL",
      tableQuery: 'SELECT * FROM "{table}" LIMIT 100',
    });
  });

  it("passes the introspected measurements to the editor", () => {
    const tables = [{ name: "cpu", columns: [{ name: "usage", type: "float" }] }];
    const schema = renderInfluxDetail(bucket({ __tables__: JSON.stringify(tables) }));
    expect(schema.sqlEditor?.tables).toEqual(tables);
  });

  it("ignores a malformed introspection payload", () => {
    const schema = renderInfluxDetail(bucket({ __tables__: "{not json" }));
    expect(schema.sqlEditor?.tables).toEqual([]);
  });
});
