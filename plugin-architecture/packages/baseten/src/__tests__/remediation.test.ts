import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { basetenRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "llama", externalId, fields };
}

const lines = (finding: RemediationFinding) =>
  basetenRemediationCommands(finding).map((c) => c.command);

describe("basetenRemediationCommands", () => {
  it("is the plugin's remediation hook", () => {
    expect(plugin.remediationCommands).toBe(basetenRemediationCommands);
  });

  it("scales an idle deployment to zero first, deactivation second", () => {
    const out = lines({
      kind: "orphan",
      reason: "idle",
      resource: res("deployment", "m1/d9", { modelId: "m1" }),
    });
    expect(out).toEqual([
      `curl -sS -X PATCH https://api.baseten.co/v1/models/m1/deployments/d9/autoscaling_settings -H "Authorization: Api-Key $BASETEN_API_KEY" -H 'Content-Type: application/json' -d '{"min_replica":0}'`,
      `curl -sS -X POST https://api.baseten.co/v1/models/m1/deployments/d9/deactivate -H "Authorization: Api-Key $BASETEN_API_KEY"`,
    ]);
    const cmd = basetenRemediationCommands({
      kind: "orphan",
      reason: "idle",
      resource: res("deployment", "m1/d9"),
    })[0]!;
    expect(cmd.placeholders?.map((p) => p.name)).toEqual(["BASETEN_API_KEY"]);
    expect(cmd.destructive).toBe(false);
  });

  it("deactivates and re-activates on a sleep schedule", () => {
    expect(
      lines({ kind: "sleep-schedule", resource: res("environment", "m1/production") }),
    ).toEqual([
      `curl -sS -X POST https://api.baseten.co/v1/models/m1/environments/production/deactivate -H "Authorization: Api-Key $BASETEN_API_KEY"`,
      `curl -sS -X POST https://api.baseten.co/v1/models/m1/environments/production/activate -H "Authorization: Api-Key $BASETEN_API_KEY"`,
    ]);
  });

  it("returns nothing it cannot address", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("deployment", null) })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("model", "m1") })).toEqual([]);
  });
});
