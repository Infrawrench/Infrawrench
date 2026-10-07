import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { xataRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "main", externalId, fields };
}

function commands(finding: RemediationFinding): string[] {
  return xataRemediationCommands(finding).map((c) => c.command);
}

describe("xataRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(xataRemediationCommands);
  });

  it("hibernates and wakes a branch", () => {
    const result = xataRemediationCommands({
      kind: "sleep-schedule",
      resource: res("xata-branch", "org1/prj1/br1", {
        organizationId: "org1",
        projectId: "prj1",
        branchId: "br1",
      }),
    });
    expect(result.map((c) => c.command)).toMatchInlineSnapshot(`
      [
        "curl -sS -X PATCH https://api.xata.tech/organizations/org1/projects/prj1/branches/br1 -H "Authorization: Bearer $XATA_API_KEY" -H 'Content-Type: application/json' -d '{"hibernate":true}'",
        "curl -sS -X PATCH https://api.xata.tech/organizations/org1/projects/prj1/branches/br1 -H "Authorization: Bearer $XATA_API_KEY" -H 'Content-Type: application/json' -d '{"hibernate":false}'",
      ]
    `);
    expect(result.every((c) => !c.destructive)).toBe(true);
    expect(result[0]?.placeholders?.map((p) => p.name)).toEqual(["XATA_API_KEY"]);
  });

  it("falls back to the external id and keeps metacharacters inside the quoted URL", () => {
    expect(
      commands({
        kind: "sleep-schedule",
        resource: res("xata-branch", "org1/prj1/b'; rm -rf ~"),
      })[0],
    ).toMatchInlineSnapshot(
      `"curl -sS -X PATCH 'https://api.xata.tech/organizations/org1/projects/prj1/branches/b'"'"'%3B%20rm%20-rf%20~' -H "Authorization: Bearer $XATA_API_KEY" -H 'Content-Type: application/json' -d '{"hibernate":true}'"`,
    );
  });

  it("returns nothing for missing ids, other types and other kinds", () => {
    expect(commands({ kind: "sleep-schedule", resource: res("xata-branch", null) })).toEqual([]);
    expect(commands({ kind: "sleep-schedule", resource: res("xata-branch", "org1/prj1") })).toEqual(
      [],
    );
    expect(
      commands({ kind: "sleep-schedule", resource: res("xata-project", "org1/prj1") }),
    ).toEqual([]);
    expect(
      commands({ kind: "orphan", reason: "x", resource: res("xata-branch", "org1/prj1/br1") }),
    ).toEqual([]);
  });
});
