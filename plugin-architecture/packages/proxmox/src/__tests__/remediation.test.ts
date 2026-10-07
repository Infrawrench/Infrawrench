import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { proxmoxRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "guest", externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return proxmoxRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

describe("proxmoxRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(proxmoxRemediationCommands);
  });

  it("shuts down and starts a VM through pvesh", () => {
    expect(
      lines({
        kind: "sleep-schedule",
        resource: res("pve-vm", "101", { vmid: 101, node: "pve1" }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- pvesh create /nodes/pve1/qemu/101/status/shutdown",
        "- pvesh create /nodes/pve1/qemu/101/status/start",
      ]
    `);
  });

  it("shuts down and starts a container through pvesh", () => {
    expect(
      lines({
        kind: "sleep-schedule",
        resource: res("pve-ct", "205", { vmid: 205, node: "pve2" }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- pvesh create /nodes/pve2/lxc/205/status/shutdown",
        "- pvesh create /nodes/pve2/lxc/205/status/start",
      ]
    `);
  });

  it("deletes an empty pool", () => {
    expect(
      lines({
        kind: "orphan",
        reason: "empty",
        resource: res("pve-pool", "staging", { poolid: "staging" }),
      }),
    ).toEqual(["! pveum pool delete staging"]);
  });

  it("quotes hostile pool ids and node names", () => {
    expect(
      lines({ kind: "orphan", reason: "empty", resource: res("pve-pool", "a; rm -rf ~") }),
    ).toEqual(["! pveum pool delete 'a; rm -rf ~'"]);
    expect(
      lines({
        kind: "sleep-schedule",
        resource: res("pve-vm", "101", { vmid: 101, node: "a b" }),
      })[0],
    ).toBe("- pvesh create '/nodes/a b/qemu/101/status/shutdown'");
  });

  it("returns nothing without a node or vmid, or for other types and kinds", () => {
    expect(
      proxmoxRemediationCommands({ kind: "sleep-schedule", resource: res("pve-vm", "101") }),
    ).toEqual([]);
    expect(
      proxmoxRemediationCommands({
        kind: "sleep-schedule",
        resource: res("pve-ct", null, { node: "pve1" }),
      }),
    ).toEqual([]);
    expect(
      proxmoxRemediationCommands({ kind: "orphan", reason: "x", resource: res("pve-pool", null) }),
    ).toEqual([]);
    expect(
      proxmoxRemediationCommands({
        kind: "orphan",
        reason: "x",
        resource: res("pve-vm", "101", { node: "pve1" }),
      }),
    ).toEqual([]);
  });
});
