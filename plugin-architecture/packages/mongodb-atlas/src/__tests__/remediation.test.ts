import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { mongodbAtlasRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

const GROUP = "5e2211c17a3e5a48f5497de3";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
  displayName = "orders-prod",
): RemediationResource {
  return { resourceTypeId, displayName, externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return mongodbAtlasRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "unused",
  resource,
});

const cluster = (fields: RemediationResource["fields"] = {}) =>
  res("cluster", `${GROUP}/orders-prod`, {
    name: "orders-prod",
    groupId: GROUP,
    instanceSize: "M40",
    region: "US_EAST_1",
    ...fields,
  });

describe("mongodbAtlasRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(mongodbAtlasRemediationCommands);
  });

  it("changes the tier of an oversized cluster", () => {
    expect(
      lines({
        kind: "oversized",
        resource: cluster(),
        sizeFieldKey: "instanceSize",
        currentSize: "M40",
        targetSize: "M30",
        region: "US_EAST_1",
      }),
    ).toMatchInlineSnapshot(`
      [
        "- atlas clusters update orders-prod --projectId 5e2211c17a3e5a48f5497de3 --tier M30",
      ]
    `);
  });

  it("pauses and starts a cluster on a schedule", () => {
    expect(lines({ kind: "sleep-schedule", resource: cluster() })).toMatchInlineSnapshot(`
      [
        "- atlas clusters pause orders-prod --projectId 5e2211c17a3e5a48f5497de3",
        "- atlas clusters start orders-prod --projectId 5e2211c17a3e5a48f5497de3",
      ]
    `);
  });

  it("deletes a paused cluster keeping its snapshots", () => {
    expect(lines(orphan(cluster({ paused: true })))).toMatchInlineSnapshot(`
      [
        "- atlas backups snapshots list orders-prod --projectId 5e2211c17a3e5a48f5497de3",
        "! atlas api clusters deleteCluster --groupId 5e2211c17a3e5a48f5497de3 --clusterName orders-prod --retainBackups",
      ]
    `);
  });

  it("resumes and lifts termination protection first when it is on", () => {
    expect(lines(orphan(cluster({ paused: true, terminationProtectionEnabled: true }))))
      .toMatchInlineSnapshot(`
      [
        "- atlas backups snapshots list orders-prod --projectId 5e2211c17a3e5a48f5497de3",
        "- atlas clusters start orders-prod --projectId 5e2211c17a3e5a48f5497de3",
        "- atlas clusters watch orders-prod --projectId 5e2211c17a3e5a48f5497de3",
        "- atlas clusters update orders-prod --projectId 5e2211c17a3e5a48f5497de3 --disableTerminationProtection",
        "! atlas api clusters deleteCluster --groupId 5e2211c17a3e5a48f5497de3 --clusterName orders-prod --retainBackups",
      ]
    `);
  });

  it("quotes a cluster name with shell metacharacters", () => {
    expect(
      lines({
        kind: "sleep-schedule",
        resource: res("cluster", null, { name: "prod'; rm -rf ~", groupId: GROUP }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- atlas clusters pause 'prod'"'"'; rm -rf ~' --projectId 5e2211c17a3e5a48f5497de3",
        "- atlas clusters start 'prod'"'"'; rm -rf ~' --projectId 5e2211c17a3e5a48f5497de3",
      ]
    `);
  });

  it("deletes an orphaned online archive", () => {
    expect(
      lines(
        orphan(
          res("online-archive", null, {
            archiveId: "5f189832e26ec075e10c32d3",
            clusterName: "orders-prod",
            groupId: GROUP,
            state: "ORPHANED",
          }),
        ),
      ),
    ).toMatchInlineSnapshot(`
      [
        "! atlas clusters onlineArchives delete 5f189832e26ec075e10c32d3 --clusterName orders-prod --projectId 5e2211c17a3e5a48f5497de3 --force",
      ]
    `);
  });

  it("deletes an unused private endpoint service for its cloud", () => {
    expect(
      lines(
        orphan(
          res("private-endpoint-service", null, {
            serviceId: "5f4fc14da2b47835a58c63a2",
            cloudProvider: "AZURE",
            groupId: GROUP,
            endpointCount: 0,
          }),
        ),
      ),
    ).toMatchInlineSnapshot(`
      [
        "! atlas privateEndpoints azure delete 5f4fc14da2b47835a58c63a2 --projectId 5e2211c17a3e5a48f5497de3 --force",
      ]
    `);
  });

  it("returns nothing for unknown types, missing ids and commitments", () => {
    expect(lines(orphan(res("search-index", "x")))).toEqual([]);
    expect(lines(orphan(res("cluster", null, { name: "orders-prod" })))).toEqual([]);
    expect(
      lines({
        kind: "idle-commitment",
        commitment: { id: "c", kind: "reservation", description: "", scope: null, region: null },
      }),
    ).toEqual([]);
  });
});
