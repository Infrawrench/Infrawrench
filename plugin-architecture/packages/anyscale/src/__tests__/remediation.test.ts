import { describe, expect, it } from "vitest";
import type { RemediationResource } from "@infrawrench/plugin-base";
import { anyscaleRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

const ws = (
  fields: RemediationResource["fields"] = {},
  externalId: string | null = "expwrk_1",
): RemediationResource => ({
  resourceTypeId: "workspace",
  displayName: "notebook",
  externalId,
  fields,
});

describe("anyscaleRemediationCommands", () => {
  it("is the plugin's remediation hook", () => {
    expect(plugin.remediationCommands).toBe(anyscaleRemediationCommands);
  });

  it("terminates an idle workspace by id", () => {
    const out = anyscaleRemediationCommands({ kind: "orphan", reason: "idle", resource: ws() });
    expect(out.map((c) => c.command)).toEqual(["anyscale workspace_v2 terminate --id expwrk_1"]);
    expect(out[0]!.destructive).toBe(false);
  });

  it("terminates and starts on a sleep schedule, quoting the id", () => {
    const out = anyscaleRemediationCommands({
      kind: "sleep-schedule",
      resource: ws({ workspaceId: "expwrk 2" }, null),
    });
    expect(out.map((c) => c.command)).toEqual([
      "anyscale workspace_v2 terminate --id 'expwrk 2'",
      "anyscale workspace_v2 start --id 'expwrk 2'",
    ]);
  });

  it("returns nothing for other types or without an id", () => {
    expect(
      anyscaleRemediationCommands({ kind: "orphan", reason: "r", resource: ws({}, null) }),
    ).toEqual([]);
    expect(
      anyscaleRemediationCommands({
        kind: "orphan",
        reason: "r",
        resource: { ...ws(), resourceTypeId: "job" },
      }),
    ).toEqual([]);
  });
});
