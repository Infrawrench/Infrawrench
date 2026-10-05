import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { snowflakeRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
  displayName = "ANALYTICS_WH",
): RemediationResource {
  return { resourceTypeId, displayName, externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return snowflakeRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

describe("snowflakeRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(snowflakeRemediationCommands);
  });

  it("turns auto-suspend on and suspends a never-suspending warehouse", () => {
    expect(
      lines({
        kind: "orphan",
        reason: "never suspends",
        resource: res("snowflake-warehouse", "ANALYTICS_WH", {
          name: "ANALYTICS_WH",
          autoSuspendNever: true,
          state: "STARTED",
        }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- snow sql -q 'ALTER WAREHOUSE "ANALYTICS_WH" SET AUTO_SUSPEND = 60'",
        "- snow sql -q 'ALTER WAREHOUSE "ANALYTICS_WH" SUSPEND'",
      ]
    `);
  });

  it("suspends and resumes a warehouse on a schedule, quoting its name", () => {
    expect(
      lines({
        kind: "sleep-schedule",
        resource: res("snowflake-warehouse", null, { name: `dev "wh"; it's` }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- snow sql -q 'ALTER WAREHOUSE "dev ""wh""; it'"'"'s" SUSPEND'",
        "- snow sql -q 'ALTER WAREHOUSE "dev ""wh""; it'"'"'s" RESUME IF SUSPENDED'",
      ]
    `);
  });

  it("suspends and resumes a task by its qualified name", () => {
    expect(
      lines({
        kind: "sleep-schedule",
        resource: res("snowflake-task", "RAW/PUBLIC/LOAD_EVENTS", {
          name: "LOAD_EVENTS",
          database: "RAW",
          schema: "PUBLIC",
        }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- snow sql -q 'ALTER TASK "RAW"."PUBLIC"."LOAD_EVENTS" SUSPEND'",
        "- snow sql -q 'ALTER TASK "RAW"."PUBLIC"."LOAD_EVENTS" RESUME'",
      ]
    `);
  });

  it("returns nothing for unknown types and unsupported kinds", () => {
    expect(
      lines({ kind: "orphan", reason: "x", resource: res("snowflake-database", "RAW") }),
    ).toEqual([]);
    expect(
      lines({
        kind: "sleep-schedule",
        resource: res("snowflake-task", null, { name: "LOAD_EVENTS" }),
      }),
    ).toEqual([]);
  });
});
