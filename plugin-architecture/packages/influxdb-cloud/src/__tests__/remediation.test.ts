import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { influxRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "rollup", externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
const lines = (finding: RemediationFinding) =>
  influxRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);

describe("influxRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(influxRemediationCommands);
  });

  it("deletes an inactive token against its region's host", () => {
    const finding: RemediationFinding = {
      kind: "orphan",
      reason: "inactive",
      resource: res("influx-token", "06c86c40a9f36000", { region: "us-east-1-1" }),
    };
    expect(lines(finding)).toMatchInlineSnapshot(`
      [
        "! influx auth delete --host https://us-east-1-1.aws.cloud2.influxdata.com --id 06c86c40a9f36000",
      ]
    `);
    expect(influxRemediationCommands(finding)[0]!.placeholders?.map((p) => p.name)).toEqual([
      "INFLUX_TOKEN",
    ]);
  });

  it("disables and re-enables a task, leaving the host to the CLI config without a region", () => {
    expect(
      lines({
        kind: "sleep-schedule",
        resource: res("influx-task", "0001234", { taskId: "0001234" }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- influx task update --id 0001234 --status inactive",
        "- influx task update --id 0001234 --status active",
      ]
    `);
  });

  it("returns nothing it cannot address", () => {
    expect(lines({ kind: "orphan", reason: "x", resource: res("influx-token", null) })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("influx-task", null) })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("influx-bucket", "b") })).toEqual([]);
  });
});
