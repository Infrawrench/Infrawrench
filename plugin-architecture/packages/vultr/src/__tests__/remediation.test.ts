import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { vultrRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

const ID = "cb676a46-66fd-4dfb-b839-443f2e6c0b60";

function res(resourceTypeId: string, externalId: string | null): RemediationResource {
  return { resourceTypeId, displayName: "web-1", externalId, fields: {} };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return vultrRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);
}

const orphan = (typeId: string, id: string | null = ID): RemediationFinding => ({
  kind: "orphan",
  reason: "x",
  resource: res(typeId, id),
});

describe("vultrRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(vultrRemediationCommands);
  });

  it("snapshots, then deletes a stopped instance", () => {
    expect(lines(orphan("instance"))).toMatchInlineSnapshot(`
      [
        "- vultr-cli snapshot create --id cb676a46-66fd-4dfb-b839-443f2e6c0b60 --description infrawrench-cb676a46-66fd-4dfb-b839-443f2e6c0b60-20261004",
        "! vultr-cli instance delete cb676a46-66fd-4dfb-b839-443f2e6c0b60",
      ]
    `);
  });

  it("deletes the other orphan types", () => {
    expect(
      ["block-storage", "load-balancer", "firewall-group", "reserved-ip"].flatMap((t) =>
        lines(orphan(t, "abc-123")),
      ),
    ).toMatchInlineSnapshot(`
      [
        "! vultr-cli block-storage delete abc-123",
        "! vultr-cli load-balancer delete abc-123",
        "! vultr-cli firewall group delete abc-123",
        "! vultr-cli reserved-ip delete abc-123",
      ]
    `);
  });

  it("stops and starts instances and bare metal", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("instance", ID) })).toMatchInlineSnapshot(`
      [
        "- vultr-cli instance stop cb676a46-66fd-4dfb-b839-443f2e6c0b60",
        "- vultr-cli instance start cb676a46-66fd-4dfb-b839-443f2e6c0b60",
      ]
    `);
    expect(lines({ kind: "sleep-schedule", resource: res("bare-metal", "bm-1") }))
      .toMatchInlineSnapshot(`
      [
        "- vultr-cli bare-metal halt bm-1",
        "- vultr-cli bare-metal start bm-1",
      ]
    `);
  });

  it("quotes an id with shell metacharacters", () => {
    expect(lines(orphan("reserved-ip", "x; rm -rf ~"))).toEqual([
      "! vultr-cli reserved-ip delete 'x; rm -rf ~'",
    ]);
  });

  it("returns nothing for missing ids, other types and other kinds", () => {
    expect(lines(orphan("instance", null))).toEqual([]);
    expect(lines(orphan("vpc"))).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("block-storage", ID) })).toEqual([]);
    expect(
      lines({
        kind: "oversized",
        resource: res("instance", ID),
        sizeFieldKey: "plan",
        currentSize: "vc2-4c-8gb",
        targetSize: "vc2-2c-4gb",
        region: "ewr",
      }),
    ).toEqual([]);
  });
});
