import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { bunnyRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(resourceTypeId: string, externalId: string | null): RemediationResource {
  return { resourceTypeId, displayName: "api", externalId, fields: {} };
}

const lines = (finding: RemediationFinding) =>
  bunnyRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);

describe("bunnyRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(bunnyRemediationCommands);
  });

  it("undeploys and redeploys a Magic Containers app", () => {
    const finding: RemediationFinding = {
      kind: "sleep-schedule",
      resource: res("container-app", "abc123"),
    };
    expect(lines(finding)).toMatchInlineSnapshot(`
      [
        "- curl -sS -X POST https://api.bunny.net/mc/apps/abc123/undeploy -H "AccessKey: $BUNNY_API_KEY"",
        "- curl -sS -X POST https://api.bunny.net/mc/apps/abc123/deploy -H "AccessKey: $BUNNY_API_KEY"",
      ]
    `);
    expect(bunnyRemediationCommands(finding)[0]!.placeholders?.map((p) => p.name)).toEqual([
      "BUNNY_API_KEY",
    ]);
  });

  it("returns nothing it cannot address", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("container-app", null) })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("pull-zone", "1") })).toEqual([]);
    expect(lines({ kind: "orphan", reason: "x", resource: res("container-app", "a") })).toEqual([]);
  });
});
