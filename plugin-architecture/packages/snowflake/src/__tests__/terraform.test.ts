import { describe, expect, it } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { mapComponent as mapStatus } from "../status-feed.js";
import { snowflakeTerraformExport } from "../terraform.js";

function res(
  typeId: string,
  externalId: string,
  fields: Record<string, string | number | boolean>,
): ResourceInstance {
  return {
    id: `acc:${typeId}:${externalId}`,
    pluginId: "snowflake",
    resourceTypeId: typeId,
    accountId: "acc",
    displayName: String(fields["name"] ?? externalId),
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    createdAt: "",
    updatedAt: "",
  };
}

describe("snowflakeTerraformExport", () => {
  it("maps a warehouse with the provider's size keyword and quoted import id", () => {
    const out = snowflakeTerraformExport.mapResource(
      res("snowflake-warehouse", "ETL_WH", {
        name: "ETL_WH",
        size: "2X-Large",
        autoSuspend: 300,
        autoResume: true,
        maxClusterCount: 3,
        minClusterCount: 1,
        resourceMonitor: "LIMIT",
      }),
    );
    expect(out?.resource.type).toBe("snowflake_warehouse");
    expect(out?.resource.importId).toBe('"ETL_WH"');
    expect(out?.resource.attributes).toMatchObject({
      warehouse_size: { kind: "string", value: "XXLARGE" },
      auto_suspend: { kind: "number", value: 300 },
      auto_resume: { kind: "string", value: "true" },
      resource_monitor: { kind: "string", value: "LIMIT" },
    });
  });

  it("maps schemas and resource monitors", () => {
    const schema = snowflakeTerraformExport.mapResource(
      res("snowflake-schema", "ANALYTICS.STAGING", { name: "STAGING", database: "ANALYTICS" }),
    );
    expect(schema?.resource.importId).toBe('"ANALYTICS"."STAGING"');
    const monitor = snowflakeTerraformExport.mapResource(
      res("snowflake-resource-monitor", "LIMIT", {
        name: "LIMIT",
        creditQuota: 100,
        frequency: "MONTHLY",
        notifyAt: "75,90",
        suspendAt: 100,
      }),
    );
    expect(monitor?.resource.attributes).toMatchObject({
      credit_quota: { kind: "number", value: 100 },
      notify_triggers: { kind: "list" },
      suspend_trigger: { kind: "number", value: 100 },
    });
  });

  it("skips types it does not map", () => {
    expect(
      snowflakeTerraformExport.mapResource(res("snowflake-user", "BOB", { name: "BOB" })),
    ).toBeNull();
  });

  it("maps status components by feature, ignoring region groups", () => {
    expect(mapStatus("Virtual Warehouses")).toEqual({
      services: ["Virtual Warehouses"],
      providerWide: true,
    });
    expect(mapStatus("AWS - US West (Oregon)")).toBeNull();
    expect(mapStatus("Snowpark Container Services")).toEqual({
      services: ["Snowpark Container Services"],
    });
  });
});
