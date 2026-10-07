import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { upcloudRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

const UUID = "00cbe2f3-4cf9-408b-afee-bd340e13cdd8";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "x", externalId, fields };
}

function orphan(resource: RemediationResource): RemediationFinding {
  return { kind: "orphan", reason: "r", resource };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return upcloudRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

describe("upcloudRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(upcloudRemediationCommands);
  });

  it("stops and starts servers and databases on a schedule", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("server", UUID) })).toEqual([
      `- upctl server stop ${UUID}`,
      `- upctl server start ${UUID}`,
    ]);
    expect(lines({ kind: "sleep-schedule", resource: res("database", UUID) })).toEqual([
      `- upctl database stop ${UUID}`,
      `- upctl database start ${UUID}`,
    ]);
  });

  it("deletes a stopped server but keeps its storages", () => {
    expect(lines(orphan(res("server", UUID)))).toEqual([`! upctl server delete ${UUID}`]);
  });

  it("backs up a detached storage before deleting it", () => {
    expect(lines(orphan(res("storage", UUID, { title: "db data" })))).toEqual([
      `- upctl storage backup create ${UUID} --title 'db data-before-delete-20261004'`,
      `! upctl storage delete ${UUID} --backups keep_latest`,
    ]);
  });

  it("releases a floating IP and deletes an empty load balancer", () => {
    expect(
      lines(orphan(res("floating-ip", "185.70.197.44", { address: "185.70.197.44" }))),
    ).toEqual(["! upctl ip-address remove 185.70.197.44"]);
    expect(lines(orphan(res("load-balancer", UUID)))).toEqual([
      `! upctl load-balancer delete ${UUID}`,
    ]);
  });

  it("quotes hostile ids", () => {
    expect(lines(orphan(res("load-balancer", "x; rm -rf ~")))).toEqual([
      "! upctl load-balancer delete 'x; rm -rf ~'",
    ]);
  });

  it("returns nothing for missing ids, other types and other kinds", () => {
    for (const t of ["server", "storage", "floating-ip", "load-balancer"]) {
      expect(lines(orphan(res(t, null)))).toEqual([]);
    }
    expect(lines({ kind: "sleep-schedule", resource: res("server", null) })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("storage", UUID) })).toEqual([]);
    expect(
      lines({
        kind: "oversized",
        resource: res("server", UUID),
        sizeFieldKey: "plan",
        currentSize: "4xCPU-8GB",
        targetSize: "2xCPU-4GB",
        region: "fi-hel1",
      }),
    ).toEqual([]);
  });
});
