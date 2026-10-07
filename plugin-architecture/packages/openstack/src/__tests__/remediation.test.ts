import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { openstackRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

function res(resourceTypeId: string, externalId: string | null): RemediationResource {
  return { resourceTypeId, displayName: "thing", externalId, fields: {} };
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "unused",
  resource,
});

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return openstackRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

const SERVER_ID = "6b2a6e2e-8a5c-4f8e-9d1a-0f3c2b1a9e77";
const VOLUME_ID = "1f0c7d3e-2b4a-4c5d-8e9f-a0b1c2d3e4f5";

describe("openstackRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(openstackRemediationCommands);
  });

  it("stops and starts a server for a sleep schedule", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("os-server", SERVER_ID) }))
      .toMatchInlineSnapshot(`
      [
        "- openstack server stop 6b2a6e2e-8a5c-4f8e-9d1a-0f3c2b1a9e77",
        "- openstack server start 6b2a6e2e-8a5c-4f8e-9d1a-0f3c2b1a9e77",
      ]
    `);
  });

  it("backs a detached volume up, then deletes it", () => {
    expect(lines(orphan(res("os-volume", VOLUME_ID)))).toMatchInlineSnapshot(`
      [
        "- openstack volume backup create --name 1f0c7d3e-2b4a-4c5d-8e9f-a0b1c2d3e4f5-final-20261004 1f0c7d3e-2b4a-4c5d-8e9f-a0b1c2d3e4f5",
        "! openstack volume delete 1f0c7d3e-2b4a-4c5d-8e9f-a0b1c2d3e4f5",
      ]
    `);
  });

  it("releases an unassociated floating IP", () => {
    expect(lines(orphan(res("os-floating-ip", "fip-1")))).toEqual([
      "! openstack floating ip delete fip-1",
    ]);
  });

  it("quotes hostile ids", () => {
    expect(lines(orphan(res("os-floating-ip", "x; rm -rf ~")))).toEqual([
      "! openstack floating ip delete 'x; rm -rf ~'",
    ]);
  });

  it("returns nothing without an id, or for other types and kinds", () => {
    expect(openstackRemediationCommands(orphan(res("os-volume", null)))).toEqual([]);
    expect(
      openstackRemediationCommands({ kind: "sleep-schedule", resource: res("os-server", " ") }),
    ).toEqual([]);
    expect(openstackRemediationCommands(orphan(res("os-server", SERVER_ID)))).toEqual([]);
    expect(
      openstackRemediationCommands({
        kind: "sleep-schedule",
        resource: res("os-volume", VOLUME_ID),
      }),
    ).toEqual([]);
  });
});
