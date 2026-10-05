import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { flyRemediationCommands } from "../remediation.js";
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
  displayName = "worker",
): RemediationResource {
  return { resourceTypeId, displayName, externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return flyRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);
}

describe("flyRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(flyRemediationCommands);
  });

  it("stops and starts a Machine", () => {
    expect(
      lines({
        kind: "sleep-schedule",
        resource: res("machine", "my-api/148ed193b95789", {
          appName: "my-api",
          state: "started",
          region: "iad",
        }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- fly machine stop 148ed193b95789 --app my-api",
        "- fly machine start 148ed193b95789 --app my-api",
      ]
    `);
  });

  it("quotes an app name with shell metacharacters", () => {
    expect(
      lines({
        kind: "sleep-schedule",
        resource: res("machine", "x/148ed193b95789", { appName: "api; rm -rf ~" }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- fly machine stop 148ed193b95789 --app 'api; rm -rf ~'",
        "- fly machine start 148ed193b95789 --app 'api; rm -rf ~'",
      ]
    `);
  });

  it("returns nothing for unknown types, missing ids and other kinds", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("volume", "my-api/vol_1") })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("machine", null) })).toEqual([]);
    expect(lines({ kind: "orphan", reason: "x", resource: res("machine", "a/b") })).toEqual([]);
  });
});
