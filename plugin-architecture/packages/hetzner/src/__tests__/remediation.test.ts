import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { hetznerRemediationCommands } from "../remediation.js";
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
  displayName = "web-1",
): RemediationResource {
  return { resourceTypeId, displayName, externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return hetznerRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "unused",
  resource,
});

describe("hetznerRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(hetznerRemediationCommands);
  });

  it("shuts down, changes type keeping the disk, and powers on", () => {
    expect(
      lines({
        kind: "oversized",
        resource: res("server", "42137865", { serverType: "cpx41", location: "fsn1" }),
        sizeFieldKey: "serverType",
        currentSize: "cpx41",
        targetSize: "cpx21",
        region: "fsn1",
      }),
    ).toMatchInlineSnapshot(`
      [
        "- hcloud server shutdown --wait --wait-timeout 5m 42137865",
        "- hcloud server change-type --keep-disk 42137865 cpx21",
        "- hcloud server poweron 42137865",
      ]
    `);
  });

  it("powers a server off and on for a sleep schedule", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("server", "42137865") }))
      .toMatchInlineSnapshot(`
      [
        "- hcloud server poweroff 42137865",
        "- hcloud server poweron 42137865",
      ]
    `);
  });

  it("deletes each orphan type", () => {
    expect([
      ...lines(orphan(res("volume", "100234567", { serverId: "" }))),
      ...lines(orphan(res("floating-ip", "4711", { serverId: "" }))),
      ...lines(orphan(res("primary-ip", "8822113", { assigneeId: "", autoDelete: false }))),
      ...lines(orphan(res("certificate", "897", { usedByLoadBalancerIds: "" }))),
    ]).toMatchInlineSnapshot(`
      [
        "! hcloud volume delete 100234567",
        "! hcloud floating-ip delete 4711",
        "! hcloud primary-ip delete 8822113",
        "! hcloud certificate delete 897",
      ]
    `);
  });

  it("quotes an unsafe target size", () => {
    expect(
      lines({
        kind: "oversized",
        resource: res("server", "42137865"),
        sizeFieldKey: "serverType",
        currentSize: "cpx41",
        targetSize: "cx22; rm -rf ~",
        region: null,
      })[1],
    ).toMatchInlineSnapshot(`"- hcloud server change-type --keep-disk 42137865 'cx22; rm -rf ~'"`);
  });

  it("returns [] for unknown types, missing ids and commitments", () => {
    expect(lines(orphan(res("network", "1")))).toEqual([]);
    expect(lines(orphan(res("volume", null)))).toEqual([]);
    expect(
      lines({
        kind: "idle-commitment",
        commitment: { id: "c", kind: "reservation", description: "", scope: null, region: null },
      }),
    ).toEqual([]);
  });
});
