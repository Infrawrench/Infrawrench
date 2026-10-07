import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { capellaRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "prod", externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
const lines = (finding: RemediationFinding) =>
  capellaRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);

describe("capellaRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(capellaRemediationCommands);
  });

  it("turns a cluster off and on for a sleep schedule", () => {
    expect(
      lines({
        kind: "sleep-schedule",
        resource: res("capella-cluster", "p1/c1", { projectId: "p1", clusterId: "c1" }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- curl -sS -X DELETE "https://cloudapi.cloud.couchbase.com/v4/organizations/$CAPELLA_ORG_ID/projects/p1/clusters/c1/activationState" -H "Authorization: Bearer $CAPELLA_API_KEY"",
        "- curl -sS -X POST "https://cloudapi.cloud.couchbase.com/v4/organizations/$CAPELLA_ORG_ID/projects/p1/clusters/c1/activationState" -H "Authorization: Bearer $CAPELLA_API_KEY" -H 'Content-Type: application/json' -d '{"turnOnLinkedAppService":true}'",
      ]
    `);
    const cmd = capellaRemediationCommands({
      kind: "sleep-schedule",
      resource: res("capella-cluster", "p1/c1"),
    })[0]!;
    expect(cmd.placeholders?.map((p) => p.name)).toEqual(["CAPELLA_API_KEY", "CAPELLA_ORG_ID"]);
  });

  it("uses the free-tier path for a free-tier cluster", () => {
    expect(
      lines({
        kind: "sleep-schedule",
        resource: res("capella-cluster", "p1/c1", { freeTier: true }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- curl -sS -X DELETE "https://cloudapi.cloud.couchbase.com/v4/organizations/$CAPELLA_ORG_ID/projects/p1/clusters/freeTier/c1/activationState" -H "Authorization: Bearer $CAPELLA_API_KEY"",
        "- curl -sS -X POST "https://cloudapi.cloud.couchbase.com/v4/organizations/$CAPELLA_ORG_ID/projects/p1/clusters/freeTier/c1/activationState" -H "Authorization: Bearer $CAPELLA_API_KEY"",
      ]
    `);
  });

  it("turns an App Service off and on", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("capella-app-service", "p1/c1/a1") }))
      .toMatchInlineSnapshot(`
      [
        "- curl -sS -X DELETE "https://cloudapi.cloud.couchbase.com/v4/organizations/$CAPELLA_ORG_ID/projects/p1/clusters/c1/appservices/a1/activationState" -H "Authorization: Bearer $CAPELLA_API_KEY"",
        "- curl -sS -X POST "https://cloudapi.cloud.couchbase.com/v4/organizations/$CAPELLA_ORG_ID/projects/p1/clusters/c1/appservices/a1/activationState" -H "Authorization: Bearer $CAPELLA_API_KEY"",
      ]
    `);
  });

  it("deletes an empty bucket and an inactive user", () => {
    expect([
      ...lines({
        kind: "orphan",
        reason: "empty",
        resource: res("capella-bucket", "p1/c1/YnVja2V0", { bucketId: "YnVja2V0" }),
      }),
      ...lines({
        kind: "orphan",
        reason: "inactive",
        resource: res("capella-user", "u-1", { userId: "u-1" }),
      }),
    ]).toMatchInlineSnapshot(`
      [
        "! curl -sS -X DELETE "https://cloudapi.cloud.couchbase.com/v4/organizations/$CAPELLA_ORG_ID/projects/p1/clusters/c1/buckets/YnVja2V0" -H "Authorization: Bearer $CAPELLA_API_KEY"",
        "! curl -sS -X DELETE "https://cloudapi.cloud.couchbase.com/v4/organizations/$CAPELLA_ORG_ID/users/u-1" -H "Authorization: Bearer $CAPELLA_API_KEY"",
      ]
    `);
  });

  it("percent-encodes ids so they cannot break out of the URL", () => {
    const [cmd] = capellaRemediationCommands({
      kind: "orphan",
      reason: "inactive",
      resource: res("capella-user", null, { userId: 'x"; rm -rf ~ $(id)' }),
    });
    expect(cmd!.command).toContain("/users/x%22%3B%20rm%20-rf%20~%20%24(id)");
  });

  it("returns nothing it cannot address", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("capella-cluster", null) })).toEqual([]);
    expect(
      lines({ kind: "orphan", reason: "x", resource: res("capella-bucket", "p1/c1") }),
    ).toEqual([]);
    expect(lines({ kind: "orphan", reason: "x", resource: res("capella-user", null) })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("capella-bucket", "p1/c1/b") })).toEqual(
      [],
    );
    expect(
      lines({
        kind: "oversized",
        resource: res("capella-cluster", "p1/c1"),
        sizeFieldKey: "compute",
        currentSize: "8/32",
        targetSize: "4/16",
        region: null,
      }),
    ).toEqual([]);
  });
});
