import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { exoscaleRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

const ZONE_ID = "ch-gva-2/0a1b2c3d-1111-2222-3333-444455556666";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = { region: "ch-gva-2" },
  displayName = "web-1",
): RemediationResource {
  return { resourceTypeId, displayName, externalId, fields };
}

function lines(finding: RemediationFinding): string[] {
  return exoscaleRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "unused",
  resource,
});

describe("exoscaleRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(exoscaleRemediationCommands);
  });

  it("stops and starts an instance for a sleep schedule", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("instance", ZONE_ID) }))
      .toMatchInlineSnapshot(`
      [
        "- exo compute instance stop -f -z ch-gva-2 0a1b2c3d-1111-2222-3333-444455556666",
        "- exo compute instance start -f -z ch-gva-2 0a1b2c3d-1111-2222-3333-444455556666",
      ]
    `);
  });

  it("snapshots then deletes a stopped instance", () => {
    expect(lines(orphan(res("instance", ZONE_ID)))).toMatchInlineSnapshot(`
      [
        "- exo compute instance snapshot create -z ch-gva-2 0a1b2c3d-1111-2222-3333-444455556666",
        "! exo compute instance delete -f -z ch-gva-2 0a1b2c3d-1111-2222-3333-444455556666",
      ]
    `);
  });

  it("snapshots then deletes an unattached volume, quoting the name", () => {
    expect(lines(orphan(res("block-storage", ZONE_ID, {}, "data vol")))).toMatchInlineSnapshot(`
      [
        "- exo compute block-storage snapshot create --name 'data vol-20261007' -z ch-gva-2 0a1b2c3d-1111-2222-3333-444455556666",
        "! exo compute block-storage delete -f -z ch-gva-2 0a1b2c3d-1111-2222-3333-444455556666",
      ]
    `);
  });

  it("releases an elastic IP and deletes an empty NLB", () => {
    expect(lines(orphan(res("elastic-ip", ZONE_ID)))).toEqual([
      "! exo compute elastic-ip delete -f -z ch-gva-2 0a1b2c3d-1111-2222-3333-444455556666",
    ]);
    expect(lines(orphan(res("nlb", ZONE_ID)))).toEqual([
      "! exo compute load-balancer delete -f -z ch-gva-2 0a1b2c3d-1111-2222-3333-444455556666",
    ]);
  });

  it("falls back to the zone field when the external id is bare", () => {
    expect(lines(orphan(res("elastic-ip", "abc")))).toEqual([
      "! exo compute elastic-ip delete -f -z ch-gva-2 abc",
    ]);
  });

  it("returns nothing without an id or for unsupported findings", () => {
    expect(lines(orphan(res("instance", null)))).toEqual([]);
    expect(lines(orphan(res("instance", "abc", {})))).toEqual([]);
    expect(lines(orphan(res("template", ZONE_ID)))).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("nlb", ZONE_ID) })).toEqual([]);
    expect(
      lines({
        kind: "oversized",
        resource: res("instance", ZONE_ID),
        sizeFieldKey: "instanceType",
        currentSize: "standard.large",
        targetSize: "standard.medium",
        region: "ch-gva-2",
      }),
    ).toEqual([]);
  });
});
