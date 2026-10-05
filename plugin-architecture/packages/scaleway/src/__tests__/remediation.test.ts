import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { scalewayRemediationCommands } from "../remediation.js";
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
  return { resourceTypeId, displayName: "web-1", externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return scalewayRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

const SERVER = "nl-ams-1/6c3b7f2e-1d4a-4b8e-9f0a-2c5d8e1f3a47";

describe("scalewayRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(scalewayRemediationCommands);
  });

  it("stops, changes commercial type, and starts an oversized instance", () => {
    expect(
      lines({
        kind: "oversized",
        resource: res("instance", SERVER, { zone: "nl-ams-1", commercialType: "PRO2-M" }),
        sizeFieldKey: "commercialType",
        currentSize: "PRO2-M",
        targetSize: "PRO2-S",
        region: "nl-ams-1",
      }),
    ).toMatchInlineSnapshot(`
      [
        "- scw instance server stop 6c3b7f2e-1d4a-4b8e-9f0a-2c5d8e1f3a47 zone=nl-ams-1 --wait",
        "- scw instance server update 6c3b7f2e-1d4a-4b8e-9f0a-2c5d8e1f3a47 commercial-type=PRO2-S zone=nl-ams-1",
        "- scw instance server start 6c3b7f2e-1d4a-4b8e-9f0a-2c5d8e1f3a47 zone=nl-ams-1 --wait",
      ]
    `);
  });

  it("powers an instance off and on for a sleep schedule", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("instance", SERVER) }))
      .toMatchInlineSnapshot(`
      [
        "- scw instance server stop 6c3b7f2e-1d4a-4b8e-9f0a-2c5d8e1f3a47 zone=nl-ams-1 --wait",
        "- scw instance server start 6c3b7f2e-1d4a-4b8e-9f0a-2c5d8e1f3a47 zone=nl-ams-1 --wait",
      ]
    `);
  });

  it("deletes an orphan flexible IP in its zone", () => {
    expect(
      lines({
        kind: "orphan",
        reason: "x",
        resource: res("flexible-ip", "fr-par-2/0e4b1c2d-3f5a-4b6c-8d7e-9f0a1b2c3d4e", {
          serverId: "",
        }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "! scw instance ip delete 0e4b1c2d-3f5a-4b6c-8d7e-9f0a1b2c3d4e zone=fr-par-2",
      ]
    `);
  });

  it("quotes an unsafe target size", () => {
    expect(
      lines({
        kind: "oversized",
        resource: res("instance", SERVER),
        sizeFieldKey: "commercialType",
        currentSize: "PRO2-M",
        targetSize: "DEV1-S'; reboot",
        region: null,
      })[1],
    ).toMatchInlineSnapshot(
      `"- scw instance server update 6c3b7f2e-1d4a-4b8e-9f0a-2c5d8e1f3a47 commercial-type='DEV1-S'"'"'; reboot' zone=nl-ams-1"`,
    );
  });

  it("returns [] for unknown types, missing ids and commitments", () => {
    expect(lines({ kind: "orphan", reason: "x", resource: res("bucket", SERVER) })).toEqual([]);
    expect(lines({ kind: "orphan", reason: "x", resource: res("flexible-ip", null) })).toEqual([]);
    expect(
      lines({
        kind: "idle-commitment",
        commitment: { id: "c", kind: "reservation", description: "", scope: null, region: null },
      }),
    ).toEqual([]);
  });
});
