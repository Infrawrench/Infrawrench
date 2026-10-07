import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { convexRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "happy-animal-123", externalId, fields };
}

function commands(finding: RemediationFinding): string[] {
  return convexRemediationCommands(finding).map((c) => c.command);
}

describe("convexRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(convexRemediationCommands);
  });

  it("pauses and unpauses a deployment by its stored URL", () => {
    const result = convexRemediationCommands({
      kind: "sleep-schedule",
      resource: res("convex-deployment", "happy-animal-123", {
        name: "happy-animal-123",
        deploymentUrl: "https://happy-animal-123.eu-west-1.convex.cloud",
      }),
    });
    expect(result.map((c) => c.command)).toMatchInlineSnapshot(`
      [
        "curl -sS -X POST https://happy-animal-123.eu-west-1.convex.cloud/api/v1/pause_deployment -H "Authorization: Convex $CONVEX_DEPLOY_KEY"",
        "curl -sS -X POST https://happy-animal-123.eu-west-1.convex.cloud/api/v1/unpause_deployment -H "Authorization: Convex $CONVEX_DEPLOY_KEY"",
      ]
    `);
    expect(result.every((c) => !c.destructive)).toBe(true);
    expect(result[0]?.placeholders?.map((p) => p.name)).toEqual(["CONVEX_DEPLOY_KEY"]);
  });

  it("falls back to the default URL from the deployment name", () => {
    expect(
      commands({ kind: "sleep-schedule", resource: res("convex-deployment", "happy-animal-123") }),
    ).toEqual([
      `curl -sS -X POST https://happy-animal-123.convex.cloud/api/v1/pause_deployment -H "Authorization: Convex $CONVEX_DEPLOY_KEY"`,
      `curl -sS -X POST https://happy-animal-123.convex.cloud/api/v1/unpause_deployment -H "Authorization: Convex $CONVEX_DEPLOY_KEY"`,
    ]);
  });

  it("refuses names and URLs that are not a plain host", () => {
    expect(
      commands({
        kind: "sleep-schedule",
        resource: res("convex-deployment", "x; rm -rf ~", { deploymentUrl: "https://a b" }),
      }),
    ).toEqual([]);
  });

  it("returns nothing for missing ids, other types and other kinds", () => {
    expect(commands({ kind: "sleep-schedule", resource: res("convex-deployment", null) })).toEqual(
      [],
    );
    expect(commands({ kind: "sleep-schedule", resource: res("convex-project", "123") })).toEqual(
      [],
    );
    expect(
      commands({ kind: "orphan", reason: "x", resource: res("convex-deployment", "a-1") }),
    ).toEqual([]);
  });
});
