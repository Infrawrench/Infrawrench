import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { tfeRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "x", externalId, fields };
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "unused",
  resource,
});

/** One line per command; "!" marks destructive ones. */
const lines = (finding: RemediationFinding) =>
  tfeRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);

describe("tfeRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(tfeRemediationCommands);
  });

  it("safe-deletes a workspace and deletes an exited agent and an unused agent token", () => {
    expect([
      ...lines(orphan(res("workspace", "ws-abc"))),
      ...lines(orphan(res("agent", "apool-1/agent-2", { agentId: "agent-2" }))),
      ...lines(orphan(res("agent-token", "apool-1/at-3"))),
    ]).toMatchInlineSnapshot(`
      [
        "! curl -sS -X POST "https://$TFE_HOSTNAME/api/v2/workspaces/ws-abc/actions/safe-delete" -H "Authorization: Bearer $TFE_TOKEN" -H 'Content-Type: application/vnd.api+json'",
        "! curl -sS -X DELETE "https://$TFE_HOSTNAME/api/v2/agents/agent-2" -H "Authorization: Bearer $TFE_TOKEN" -H 'Content-Type: application/vnd.api+json'",
        "! curl -sS -X DELETE "https://$TFE_HOSTNAME/api/v2/authentication-tokens/at-3" -H "Authorization: Bearer $TFE_TOKEN" -H 'Content-Type: application/vnd.api+json'",
      ]
    `);
    expect(
      tfeRemediationCommands(orphan(res("workspace", "ws-abc")))[0]!.placeholders?.map(
        (p) => p.name,
      ),
    ).toEqual(["TFE_HOSTNAME", "TFE_TOKEN"]);
  });

  it("returns nothing it cannot address", () => {
    expect(lines(orphan(res("workspace", null)))).toEqual([]);
    expect(lines(orphan(res("agent", "apool-1")))).toEqual([]);
    expect(lines(orphan(res("agent-token", null)))).toEqual([]);
    expect(lines(orphan(res("project", "prj-1")))).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("workspace", "ws-abc") })).toEqual([]);
  });
});
