import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { digitaloceanRemediationCommands } from "../remediation.js";
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
  return digitaloceanRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

describe("digitaloceanRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(digitaloceanRemediationCommands);
  });

  it("resizes an oversized droplet without touching the disk", () => {
    expect(
      lines({
        kind: "oversized",
        resource: res("droplet", "386734086", { region: "nyc3", size: "s-4vcpu-8gb" }),
        sizeFieldKey: "size",
        currentSize: "s-4vcpu-8gb",
        targetSize: "s-2vcpu-4gb",
        region: "nyc3",
      }),
    ).toMatchInlineSnapshot(`
      [
        "- doctl compute droplet-action resize 386734086 --size s-2vcpu-4gb --wait",
        "- doctl compute droplet-action power-on 386734086 --wait",
      ]
    `);
  });

  it("powers a droplet off and on for a sleep schedule", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("droplet", "386734086") }))
      .toMatchInlineSnapshot(`
      [
        "- doctl compute droplet-action power-off 386734086 --wait",
        "- doctl compute droplet-action power-on 386734086 --wait",
      ]
    `);
  });

  it("snapshots before deleting an orphan volume, quoting unsafe names", () => {
    expect(
      lines({
        kind: "orphan",
        reason: "Volume is not attached to any Droplet",
        resource: res(
          "volume",
          "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
          { name: "data'; rm -rf ~", dropletIds: "" },
          "data'; rm -rf ~",
        ),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- doctl compute volume snapshot f81d4fae-7dec-11d0-a765-00a0c91e6bf6 --snapshot-name 'data'"'"'; rm -rf ~-pre-delete-20261004'",
        "! doctl compute volume delete f81d4fae-7dec-11d0-a765-00a0c91e6bf6 --force",
      ]
    `);
  });

  it("releases an orphan reserved IP", () => {
    expect(
      lines({
        kind: "orphan",
        reason: "x",
        resource: res("reserved-ip", "203.0.113.25", { ip: "203.0.113.25" }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "! doctl compute reserved-ip delete 203.0.113.25 --force",
      ]
    `);
  });

  it("deletes an orphan load balancer and firewall", () => {
    expect([
      ...lines({
        kind: "orphan",
        reason: "x",
        resource: res("load-balancer", "4de7ac8b-495b-4884-9a69-1050c6793cd6"),
      }),
      ...lines({
        kind: "orphan",
        reason: "x",
        resource: res("firewall", "bb4b2611-3d72-467b-8602-280330ecd65c"),
      }),
    ]).toMatchInlineSnapshot(`
      [
        "! doctl compute load-balancer delete 4de7ac8b-495b-4884-9a69-1050c6793cd6 --force",
        "! doctl compute firewall delete bb4b2611-3d72-467b-8602-280330ecd65c --force",
      ]
    `);
  });

  it("returns [] for unknown types, missing ids and commitments", () => {
    expect(lines({ kind: "orphan", reason: "x", resource: res("spaces-bucket", "b") })).toEqual([]);
    expect(lines({ kind: "orphan", reason: "x", resource: res("volume", null) })).toEqual([]);
    expect(
      lines({
        kind: "idle-commitment",
        commitment: { id: "c", kind: "reservation", description: "", scope: null, region: null },
      }),
    ).toEqual([]);
  });
});
