import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { astraRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";
import { T } from "../resource-types.js";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "vector-db", externalId, fields };
}

function lines(finding: RemediationFinding): string[] {
  return astraRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "idle",
  resource,
});

const DB = "3c5f1c1e-1111-2222-3333-444455556666";
const PCU = "9a8b7c6d-1111-2222-3333-444455556666";

describe("astraRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(astraRemediationCommands);
  });

  it("resumes or deletes a hibernated database", () => {
    expect(lines(orphan(res(T.database, DB)))).toEqual([
      `- astra db resume ${DB}`,
      `! astra db delete ${DB} --yes`,
    ]);
  });

  it("parks or deletes an unused flexible PCU group", () => {
    expect(lines(orphan(res(T.pcuGroup, PCU, { reserved: 0 })))).toEqual([
      `- astra pcu park ${PCU}`,
      `! astra pcu delete ${PCU} --yes`,
    ]);
  });

  it("only offers delete for a committed PCU group", () => {
    expect(lines(orphan(res(T.pcuGroup, PCU, { reserved: 4 })))).toEqual([
      `! astra pcu delete ${PCU} --yes`,
    ]);
    expect(
      lines({ kind: "sleep-schedule", resource: res(T.pcuGroup, PCU, { reserved: 4 }) }),
    ).toEqual([]);
  });

  it("parks and unparks a PCU group for a sleep schedule", () => {
    expect(lines({ kind: "sleep-schedule", resource: res(T.pcuGroup, PCU) })).toEqual([
      `- astra pcu park ${PCU}`,
      `- astra pcu unpark ${PCU}`,
    ]);
  });

  it("returns nothing without an id or for other findings", () => {
    expect(lines(orphan(res(T.database, null)))).toEqual([]);
    expect(lines(orphan(res(T.pcuGroup, null)))).toEqual([]);
    expect(lines(orphan(res(T.keyspace, "db/ks")))).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res(T.database, DB) })).toEqual([]);
  });
});
