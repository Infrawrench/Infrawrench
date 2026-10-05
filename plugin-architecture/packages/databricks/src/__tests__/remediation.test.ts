import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { databricksRemediationCommands } from "../remediation.js";
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
  displayName = "etl",
): RemediationResource {
  return { resourceTypeId, displayName, externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return databricksRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

const sleep = (resource: RemediationResource): RemediationFinding => ({
  kind: "sleep-schedule",
  resource,
});

describe("databricksRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(databricksRemediationCommands);
  });

  it("terminates and starts a cluster", () => {
    const commands = databricksRemediationCommands(
      sleep(
        res("databricks-cluster", "0923-164208-meows279", {
          clusterId: "0923-164208-meows279",
          state: "RUNNING",
        }),
      ),
    );
    expect(commands.map((c) => c.command)).toMatchInlineSnapshot(`
      [
        "databricks clusters delete 0923-164208-meows279 --profile "$DATABRICKS_PROFILE"",
        "databricks clusters start 0923-164208-meows279 --profile "$DATABRICKS_PROFILE"",
      ]
    `);
    expect(commands[0]?.placeholders?.map((p) => p.name)).toEqual(["DATABRICKS_PROFILE"]);
  });

  it("stops and starts a SQL warehouse", () => {
    expect(lines(sleep(res("databricks-sql-warehouse", "1234567890abcdef", { state: "RUNNING" }))))
      .toMatchInlineSnapshot(`
      [
        "- databricks warehouses stop 1234567890abcdef --profile "$DATABRICKS_PROFILE"",
        "- databricks warehouses start 1234567890abcdef --profile "$DATABRICKS_PROFILE"",
      ]
    `);
  });

  it("stops and starts an app, quoting its name", () => {
    expect(lines(sleep(res("databricks-app", "dash; rm -rf ~", { name: "dash; rm -rf ~" }))))
      .toMatchInlineSnapshot(`
      [
        "- databricks apps stop 'dash; rm -rf ~' --profile "$DATABRICKS_PROFILE"",
        "- databricks apps start 'dash; rm -rf ~' --profile "$DATABRICKS_PROFILE"",
      ]
    `);
  });

  it("returns nothing for unknown types, missing ids and other kinds", () => {
    expect(lines(sleep(res("databricks-job", "123")))).toEqual([]);
    expect(lines(sleep(res("databricks-cluster", null)))).toEqual([]);
    expect(
      lines({ kind: "orphan", reason: "x", resource: res("databricks-cluster", "0923") }),
    ).toEqual([]);
  });
});
