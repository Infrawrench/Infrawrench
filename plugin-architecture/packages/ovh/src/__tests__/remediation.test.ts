import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { ovhRemediationCommands } from "../remediation.js";
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
): RemediationResource {
  return { resourceTypeId, displayName: String(fields["name"] ?? "web-1"), externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return ovhRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);
}

describe("ovhRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(ovhRemediationCommands);
  });

  it("stops and starts an instance with the project placeholder", () => {
    const finding: RemediationFinding = {
      kind: "sleep-schedule",
      resource: res("instance", "5f1c2a3b-4d5e-6f70-8192-a3b4c5d6e7f8", { region: "GRA11" }),
    };
    expect(lines(finding)).toMatchInlineSnapshot(`
      [
        "- ovhcloud cloud instance stop 5f1c2a3b-4d5e-6f70-8192-a3b4c5d6e7f8 --cloud-project "$OVH_CLOUD_PROJECT"",
        "- ovhcloud cloud instance start 5f1c2a3b-4d5e-6f70-8192-a3b4c5d6e7f8 --cloud-project "$OVH_CLOUD_PROJECT"",
      ]
    `);
    expect(ovhRemediationCommands(finding)[0]?.placeholders?.[0]?.name).toBe("OVH_CLOUD_PROJECT");
  });

  it("snapshots before deleting an orphan volume, quoting unsafe names", () => {
    expect(
      lines({
        kind: "orphan",
        reason: "Volume is not attached to any instance",
        resource: res("volume", "0b9a8c7d-6e5f-4a3b-2c1d-0e9f8a7b6c5d", {
          name: "db $(whoami)",
          attachedTo: "",
        }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- ovhcloud cloud storage block snapshot create 0b9a8c7d-6e5f-4a3b-2c1d-0e9f8a7b6c5d --name 'db $(whoami)-pre-delete-20261004' --wait --cloud-project "$OVH_CLOUD_PROJECT"",
        "! ovhcloud cloud storage block volume delete 0b9a8c7d-6e5f-4a3b-2c1d-0e9f8a7b6c5d --cloud-project "$OVH_CLOUD_PROJECT"",
      ]
    `);
  });

  it("returns [] for unknown types, oversized, missing ids and commitments", () => {
    expect(lines({ kind: "orphan", reason: "x", resource: res("floating-ip", "GRA11/x") })).toEqual(
      [],
    );
    expect(lines({ kind: "orphan", reason: "x", resource: res("volume", null) })).toEqual([]);
    expect(
      lines({
        kind: "oversized",
        resource: res("instance", "i"),
        sizeFieldKey: "flavorName",
        currentSize: "b3-16",
        targetSize: "b3-8",
        region: "GRA11",
      }),
    ).toEqual([]);
    expect(
      lines({
        kind: "idle-commitment",
        commitment: { id: "c", kind: "reservation", description: "", scope: null, region: null },
      }),
    ).toEqual([]);
  });
});
