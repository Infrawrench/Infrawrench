import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateOrphanRule } from "@infrawrench/plugin-base";
import { SnowflakeClient } from "../client.js";
import { monitorTriggers, recommendWarehouse } from "../insights.js";
import { plugin } from "../plugin.js";
import { TYPE, WarehouseResourceType } from "../resource-types.js";
import { CREDS, jsonResponse, mockSnowflake, resultSet } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const showWarehouses = () =>
  jsonResponse(
    200,
    resultSet(
      [
        { name: "name" },
        { name: "state" },
        { name: "type" },
        { name: "size" },
        { name: "auto_suspend", type: "fixed" },
        { name: "auto_resume" },
        { name: "running", type: "fixed" },
        { name: "queued", type: "fixed" },
        { name: "resource_monitor" },
        { name: "max_cluster_count", type: "fixed" },
      ],
      [
        ["ETL_WH", "STARTED", "STANDARD", "Large", null, "true", "2", "0", "null", "1"],
        ["BI_WH", "SUSPENDED", "STANDARD", "X-Small", "60", "true", "0", "0", "LIMIT", "3"],
      ],
    ),
  );

describe("listing", () => {
  it("lists warehouses from SHOW WAREHOUSES only", async () => {
    const { statements } = mockSnowflake((s) =>
      s === "SHOW WAREHOUSES" ? showWarehouses() : undefined,
    );
    const client = new SnowflakeClient(CREDS);
    const list = await client.listResources(TYPE.warehouse, "acc");
    expect(statements).toEqual(["SHOW WAREHOUSES"]);
    expect(list.map((r) => r.id)).toEqual([
      "acc:snowflake-warehouse:ETL_WH",
      "acc:snowflake-warehouse:BI_WH",
    ]);
    const etl = list[0]!;
    expect(etl.fields).toMatchObject({
      size: "Large",
      autoSuspend: 0,
      autoSuspendNever: true,
      state: "STARTED",
    });
    expect(etl.fields["resourceMonitor"]).toBeUndefined();
    expect(list[1]!.fields["resourceMonitor"]).toBe("LIMIT");
    // The orphan rule flags a running warehouse that never suspends, not a suspended one.
    expect(evaluateOrphanRule(WarehouseResourceType.orphanRule, etl.fields)).toMatch(/idle/);
    expect(evaluateOrphanRule(WarehouseResourceType.orphanRule, list[1]!.fields)).toBeNull();
  });

  it("lists users as empty when the role cannot SHOW USERS", async () => {
    mockSnowflake(() =>
      jsonResponse(422, {
        code: "003001",
        message: "Insufficient privileges to operate on account",
      }),
    );
    expect(await new SnowflakeClient(CREDS).listResources(TYPE.user, "acc")).toEqual([]);
  });
});

describe("actions", () => {
  it("resizes, sets auto-suspend and assigns monitors with quoted identifiers", async () => {
    const { statements } = mockSnowflake(() =>
      jsonResponse(200, resultSet([{ name: "status" }], [["ok"]])),
    );
    const client = new SnowflakeClient(CREDS);
    const id = "acc:snowflake-warehouse:ETL_WH";
    await client.executeNoSqlCommand(TYPE.warehouse, id, "acc", "resize", [
      JSON.stringify({ size: "SMALL" }),
    ]);
    await client.executeNoSqlCommand(TYPE.warehouse, id, "acc", "set-auto-suspend", [
      JSON.stringify({ seconds: "0" }),
    ]);
    await client.executeNoSqlCommand(TYPE.warehouse, id, "acc", "assign-monitor", [
      JSON.stringify({ monitor: "" }),
    ]);
    await client.invokeAction(TYPE.warehouse, id, "resize:XLARGE", "acc");
    await client.invokeAction(TYPE.warehouse, id, "resume", "acc");
    await client.invokeAction(TYPE.task, "acc:snowflake-task:DB.PUBLIC.NIGHTLY", "execute", "acc");
    expect(statements).toEqual([
      'ALTER WAREHOUSE "ETL_WH" SET WAREHOUSE_SIZE = SMALL',
      'ALTER WAREHOUSE "ETL_WH" SET AUTO_SUSPEND = NULL',
      'ALTER WAREHOUSE "ETL_WH" UNSET RESOURCE_MONITOR',
      'ALTER WAREHOUSE "ETL_WH" SET WAREHOUSE_SIZE = XLARGE',
      'ALTER WAREHOUSE "ETL_WH" RESUME IF SUSPENDED',
      'EXECUTE TASK "DB"."PUBLIC"."NIGHTLY"',
    ]);
  });

  it("runs SQL editor statements in the resource's context", async () => {
    const { bodies } = mockSnowflake(() => jsonResponse(200, resultSet([{ name: "X" }], [["1"]])));
    const client = new SnowflakeClient(CREDS);
    const res = await client.executeQuery(
      "acc:snowflake-schema:ANALYTICS.STAGING",
      "acc",
      "select 1",
    );
    expect(res.rows).toEqual([{ X: "1" }]);
    expect(bodies[0]).toMatchObject({ database: "ANALYTICS", schema: "STAGING" });
  });
});

describe("resource monitors", () => {
  it("rebuilds the whole TRIGGERS clause from current values plus edits", async () => {
    const { statements } = mockSnowflake((s) => {
      if (s.startsWith("SHOW RESOURCE MONITORS")) {
        return jsonResponse(
          200,
          resultSet(
            [
              { name: "name" },
              { name: "credit_quota" },
              { name: "frequency" },
              { name: "notify_at" },
              { name: "suspend_at" },
              { name: "suspend_immediately_at" },
            ],
            [["LIMIT", "100", "MONTHLY", "75%,90%", "100%", "110%"]],
          ),
        );
      }
      if (s === "SHOW WAREHOUSES") return showWarehouses();
      if (s.startsWith("ALTER RESOURCE MONITOR"))
        return jsonResponse(200, resultSet([{ name: "s" }], []));
      return undefined;
    });
    await new SnowflakeClient(CREDS).updateResource(
      TYPE.resourceMonitor,
      "acc:snowflake-resource-monitor:LIMIT",
      "acc",
      { creditQuota: "250", suspendAt: "95" },
    );
    expect(statements).toContain(
      'ALTER RESOURCE MONITOR "LIMIT" SET CREDIT_QUOTA = 250 TRIGGERS ON 75 PERCENT DO NOTIFY ON 90 PERCENT DO NOTIFY ON 95 PERCENT DO SUSPEND ON 110 PERCENT DO SUSPEND_IMMEDIATE',
    );
  });

  it("builds triggers", () => {
    expect(monitorTriggers({ notifyAt: "", suspendAt: "", suspendImmediatelyAt: undefined })).toBe(
      "",
    );
    expect(monitorTriggers({ suspendImmediatelyAt: 100 })).toBe(
      "TRIGGERS ON 100 PERCENT DO SUSPEND_IMMEDIATE",
    );
  });
});

describe("recommendations", () => {
  const busy = { activeHours: 50, avgRunning: 0.1, avgQueued: 0, credits: 400, days: 14 };

  it("flags auto-suspend off and too long", () => {
    expect(recommendWarehouse({ size: "Small", autoSuspend: 0 }, undefined)[0]?.id).toBe(
      "never-suspends",
    );
    expect(recommendWarehouse({ size: "Small", autoSuspend: 3600 }, undefined)[0]?.id).toBe(
      "long-auto-suspend",
    );
    expect(recommendWarehouse({ size: "Small", autoSuspend: 60 }, undefined)).toEqual([]);
  });

  it("suggests one size down for an underused Medium or larger", () => {
    const recs = recommendWarehouse({ size: "Large", autoSuspend: 60 }, busy);
    expect(recs).toEqual([expect.objectContaining({ id: "downsize", size: "Medium" })]);
    expect(recommendWarehouse({ size: "Small", autoSuspend: 60 }, busy)).toEqual([]);
  });

  it("notes queueing and unused warehouses", () => {
    expect(
      recommendWarehouse(
        { size: "Medium", autoSuspend: 60 },
        { ...busy, avgRunning: 0.9, avgQueued: 0.5 },
      )[0]?.id,
    ).toBe("queueing");
    expect(
      recommendWarehouse(
        { size: "Medium", autoSuspend: 60 },
        { ...busy, activeHours: 0, credits: 0 },
      )[0]?.id,
    ).toBe("unused");
  });
});

describe("credential pickers", () => {
  it("lists the roles granted to the user", async () => {
    mockSnowflake(() =>
      jsonResponse(200, resultSet([{ name: "ROLES" }], [['["SYSADMIN","PUBLIC","ANALYST"]']])),
    );
    const options = await plugin.listCredentialOptions!("role", CREDS);
    expect(options.map((o) => o.id)).toEqual(["ANALYST", "PUBLIC", "SYSADMIN"]);
  });

  it("lists warehouses as the chosen role", async () => {
    const { bodies } = mockSnowflake(() => showWarehouses());
    const options = await plugin.listCredentialOptions!("warehouse", { ...CREDS, role: "ANALYST" });
    expect(options[0]).toEqual({ id: "ETL_WH", label: "ETL_WH", description: "Large, started" });
    expect(bodies[0]).toMatchObject({ role: "ANALYST" });
  });
});
