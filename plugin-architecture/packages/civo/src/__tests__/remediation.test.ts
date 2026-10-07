import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding } from "@infrawrench/plugin-base";
import { civoRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

const resource = (resourceTypeId: string, externalId: string | null) => ({
  resourceTypeId,
  displayName: "web-1",
  externalId,
  fields: {},
});
const orphan = (typeId: string, id: string | null): RemediationFinding => ({
  kind: "orphan",
  reason: "x",
  resource: resource(typeId, id),
});

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return civoRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);
}

describe("civoRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(civoRemediationCommands);
  });

  it("snapshots, then removes a shut-off instance", () => {
    expect(lines(orphan("instance", "LON1/b5f82266"))).toMatchInlineSnapshot(`
      [
        "- civo instance snapshot create b5f82266 --name infrawrench-b5f82266-20261004 --region LON1",
        "! civo instance remove b5f82266 --region LON1 -y",
      ]
    `);
  });

  it("deletes volumes, reserved IPs and load balancers", () => {
    expect([
      ...lines(orphan("volume", "NYC1/vol-1")),
      ...lines(orphan("reserved-ip", "NYC1/ip-1")),
      ...lines(orphan("load-balancer", "NYC1/lb-1")),
    ]).toMatchInlineSnapshot(`
      [
        "! civo volume remove vol-1 --region NYC1 -y",
        "! civo ip delete ip-1 --region NYC1 -y",
        "! curl -sS -X DELETE 'https://api.civo.com/v2/loadbalancers/lb-1?region=NYC1' -H "Authorization: bearer $CIVO_TOKEN"",
      ]
    `);
    expect(
      civoRemediationCommands(orphan("load-balancer", "NYC1/lb-1"))[0]?.placeholders?.map(
        (p) => p.name,
      ),
    ).toEqual(["CIVO_TOKEN"]);
  });

  it("stops and starts an instance", () => {
    expect(lines({ kind: "sleep-schedule", resource: resource("instance", "FRA1/i-1") }))
      .toMatchInlineSnapshot(`
      [
        "- civo instance stop i-1 --region FRA1",
        "- civo instance start i-1 --region FRA1",
      ]
    `);
  });

  it("quotes an id with shell metacharacters", () => {
    expect(lines(orphan("volume", "LON1/x; rm -rf ~"))).toEqual([
      "! civo volume remove 'x; rm -rf ~' --region LON1 -y",
    ]);
  });

  it("returns nothing for missing ids, other types and other kinds", () => {
    expect(lines(orphan("instance", null))).toEqual([]);
    expect(lines(orphan("instance", "b5f82266"))).toEqual([]);
    expect(lines(orphan("network", "LON1/n-1"))).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: resource("volume", "LON1/v-1") })).toEqual([]);
  });
});
