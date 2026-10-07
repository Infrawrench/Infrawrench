import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { ibmRemediationCommands } from "../remediation.js";
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
): RemediationResource {
  return { resourceTypeId, displayName: "web-1", externalId, fields };
}

function lines(finding: RemediationFinding): string[] {
  return ibmRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "unused",
  resource,
});

describe("ibmRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(ibmRemediationCommands);
  });

  it("stops and starts a server for a sleep schedule", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("instance", "us-south/0717_abc") }))
      .toMatchInlineSnapshot(`
      [
        "- ibmcloud target -r us-south",
        "- ibmcloud is instance-stop 0717_abc -f",
        "- ibmcloud is instance-start 0717_abc",
      ]
    `);
  });

  it("snapshots the boot volume then deletes a stopped server", () => {
    expect(lines(orphan(res("instance", "us-south/0717_abc", { bootVolumeId: "r006-Boot_1" }))))
      .toMatchInlineSnapshot(`
      [
        "- ibmcloud target -r us-south",
        "- ibmcloud is snapshot-create --source-volume r006-Boot_1 --name iw-r006-boot-1-20261007",
        "! ibmcloud is instance-delete 0717_abc -f",
      ]
    `);
    expect(lines(orphan(res("instance", "us-south/0717_abc")))).toEqual([
      "- ibmcloud target -r us-south",
      "! ibmcloud is instance-delete 0717_abc -f",
    ]);
  });

  it("snapshots then deletes an unattached volume", () => {
    expect(lines(orphan(res("volume", "eu-de/r010-vol")))).toEqual([
      "- ibmcloud target -r eu-de",
      "- ibmcloud is snapshot-create --source-volume r010-vol --name iw-r010-vol-20261007",
      "! ibmcloud is volume-delete r010-vol -f",
    ]);
  });

  it("releases a floating IP and deletes an empty load balancer", () => {
    expect(lines(orphan(res("floating-ip", "eu-de/r010-fip")))).toEqual([
      "- ibmcloud target -r eu-de",
      "! ibmcloud is floating-ip-release r010-fip -f",
    ]);
    expect(lines(orphan(res("load-balancer", "eu-de/r010-lb")))).toEqual([
      "- ibmcloud target -r eu-de",
      "! ibmcloud is load-balancer-delete r010-lb -f",
    ]);
  });

  it("returns nothing without an id or for other findings", () => {
    expect(lines(orphan(res("volume", null)))).toEqual([]);
    expect(lines(orphan(res("volume", "r010-vol")))).toEqual([]);
    expect(lines(orphan(res("vpc", "eu-de/r010-vpc")))).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("volume", "eu-de/v") })).toEqual([]);
  });
});
