import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { qdrantRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(resourceTypeId: string, externalId: string | null): RemediationResource {
  return { resourceTypeId, displayName: "prod", externalId, fields: {} };
}

const ID = "7b2ea926-724b-4de2-b73a-8675c42a6ebe";

describe("qdrantRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(qdrantRemediationCommands);
  });

  it("suspends and unsuspends a cluster for a sleep schedule", () => {
    const cmds = qdrantRemediationCommands({
      kind: "sleep-schedule",
      resource: res("cluster", ID),
    });
    expect(cmds.map((c) => c.command)).toEqual([
      `qcloud cluster suspend ${ID} --force`,
      `qcloud cluster unsuspend ${ID}`,
    ]);
    expect(cmds.every((c) => !c.destructive)).toBe(true);
    expect(cmds[0]?.placeholders?.map((p) => p.name)).toEqual([
      "QDRANT_CLOUD_API_KEY",
      "QDRANT_CLOUD_ACCOUNT_ID",
    ]);
  });

  it("returns nothing without an id or for other findings", () => {
    const none: RemediationFinding[] = [
      { kind: "sleep-schedule", resource: res("cluster", null) },
      { kind: "sleep-schedule", resource: res("backup", ID) },
      { kind: "orphan", reason: "x", resource: res("cluster", ID) },
    ];
    for (const f of none) expect(qdrantRemediationCommands(f)).toEqual([]);
  });
});
