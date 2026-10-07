import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { paperspaceRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
  displayName = "gpu box",
): RemediationResource {
  return { resourceTypeId, displayName, externalId, fields };
}

function lines(finding: RemediationFinding): string[] {
  return paperspaceRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "off",
  resource,
});

describe("paperspaceRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(paperspaceRemediationCommands);
  });

  it("stops and starts a machine for a sleep schedule", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("machine", "psabc123") })).toEqual([
      "- pspace machine stop psabc123",
      "- pspace machine start psabc123",
    ]);
  });

  it("templates then deletes a machine that is off", () => {
    expect(lines(orphan(res("machine", "psabc123")))).toEqual([
      "- pspace template create --name 'gpu box-20261007' --machine-id psabc123",
      "! pspace machine delete psabc123",
    ]);
  });

  it("releases an unassigned public IP", () => {
    expect(lines(orphan(res("public-ip", "203.0.113.7", { ip: "203.0.113.7" })))).toEqual([
      "! pspace public-ip release 203.0.113.7",
    ]);
  });

  it("returns nothing without an id or for other findings", () => {
    expect(lines(orphan(res("machine", null)))).toEqual([]);
    expect(lines(orphan(res("public-ip", null)))).toEqual([]);
    expect(lines(orphan(res("snapshot", "s1")))).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("public-ip", "1.2.3.4") })).toEqual([]);
  });
});
