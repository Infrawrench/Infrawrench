import { describe, expect, it } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { datadogTerraformExport } from "../terraform.js";

function monitor(fields: Record<string, string | number | boolean>): ResourceInstance {
  return {
    id: "acc:monitor:42",
    pluginId: "datadog",
    resourceTypeId: "monitor",
    accountId: "acc",
    displayName: "CPU high",
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId: "42",
    createdAt: "",
    updatedAt: "",
  };
}

describe("datadogTerraformExport", () => {
  it("maps a monitor with thresholds, priority and tags", () => {
    const result = datadogTerraformExport.mapResource(
      monitor({
        name: "CPU high",
        type: "metric alert",
        query: "avg(last_5m):avg:system.cpu.user{*} > 90",
        message: "@pagerduty",
        priority: "2",
        tags: "team:core, env:prod",
        thresholdsJson: JSON.stringify({ critical: 90, warning: 80, ok: null }),
      }),
    );
    expect(result?.resource.type).toBe("datadog_monitor");
    expect(result?.resource.importId).toBe("42");
    expect(result?.resource.attributes).toMatchObject({
      name: { kind: "string", value: "CPU high" },
      type: { kind: "string", value: "metric alert" },
      priority: { kind: "string", value: "2" },
      tags: {
        kind: "list",
        items: [
          { kind: "string", value: "team:core" },
          { kind: "string", value: "env:prod" },
        ],
      },
      monitor_thresholds: {
        kind: "block",
        attributes: {
          critical: { kind: "number", value: 90 },
          warning: { kind: "number", value: 80 },
        },
      },
    });
  });

  it("refuses a monitor without a query", () => {
    expect(datadogTerraformExport.mapResource(monitor({ name: "x", type: "metric alert" }))).toBe(
      null,
    );
  });
});
