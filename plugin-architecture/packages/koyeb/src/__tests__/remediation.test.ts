import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { koyebRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

const UUID = "2c1e4d5a-6b7c-4d8e-9f01-23456789abcd";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "x", externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return koyebRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);
}

describe("koyebRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(koyebRemediationCommands);
  });

  it("pauses and resumes apps and services", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("app", UUID) })).toEqual([
      `- koyeb apps pause ${UUID}`,
      `- koyeb apps resume ${UUID}`,
    ]);
    expect(lines({ kind: "sleep-schedule", resource: res("service", UUID) })).toEqual([
      `- koyeb services pause ${UUID}`,
      `- koyeb services resume ${UUID}`,
    ]);
  });

  it("snapshots a detached volume before deleting it", () => {
    expect(
      lines({ kind: "orphan", reason: "r", resource: res("volume", UUID, { name: "pg data" }) }),
    ).toEqual([
      `- koyeb snapshots create 'pg data-before-delete-20261004' ${UUID}`,
      `! koyeb volumes delete ${UUID}`,
    ]);
  });

  it("returns nothing for missing ids, other types and other kinds", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("app", null) })).toEqual([]);
    expect(lines({ kind: "orphan", reason: "r", resource: res("volume", null) })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("volume", UUID) })).toEqual([]);
    expect(lines({ kind: "orphan", reason: "r", resource: res("app", UUID) })).toEqual([]);
  });
});
