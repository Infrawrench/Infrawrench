import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { vsphereRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(resourceTypeId: string, externalId: string | null): RemediationResource {
  return { resourceTypeId, displayName: "web-1", externalId, fields: { name: "web-1" } };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return vsphereRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

describe("vsphereRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(vsphereRemediationCommands);
  });

  it("shuts the guest down and powers on by managed object reference", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("vsphere-vm", "vm-42") }))
      .toMatchInlineSnapshot(`
      [
        "- govc vm.power -s VirtualMachine:vm-42",
        "- govc vm.power -on VirtualMachine:vm-42",
      ]
    `);
  });

  it("quotes a hostile id", () => {
    expect(
      lines({ kind: "sleep-schedule", resource: res("vsphere-vm", "vm-1; rm -rf ~") })[0],
    ).toBe("- govc vm.power -s 'VirtualMachine:vm-1; rm -rf ~'");
  });

  it("returns nothing without an id, or for other types and kinds", () => {
    expect(
      vsphereRemediationCommands({ kind: "sleep-schedule", resource: res("vsphere-vm", null) }),
    ).toEqual([]);
    expect(
      vsphereRemediationCommands({
        kind: "sleep-schedule",
        resource: res("vsphere-host", "host-1"),
      }),
    ).toEqual([]);
    expect(
      vsphereRemediationCommands({
        kind: "orphan",
        reason: "x",
        resource: res("vsphere-vm", "vm-42"),
      }),
    ).toEqual([]);
  });
});
