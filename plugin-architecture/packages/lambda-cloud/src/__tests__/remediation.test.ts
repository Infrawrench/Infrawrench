import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { lambdaCloudRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(resourceTypeId: string, externalId: string | null): RemediationResource {
  return { resourceTypeId, displayName: "x", externalId, fields: { inUse: false } };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return lambdaCloudRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

describe("lambdaCloudRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(lambdaCloudRemediationCommands);
  });

  it("deletes an unmounted filesystem", () => {
    const commands = lambdaCloudRemediationCommands({
      kind: "orphan",
      reason: "r",
      resource: res("filesystem", "398578a2336b49079e74043f0bd2cfe8"),
    });
    expect(commands.map((c) => c.command)).toEqual([
      `curl -sS -X DELETE https://cloud.lambda.ai/api/v1/filesystems/398578a2336b49079e74043f0bd2cfe8 -H "Authorization: Bearer $LAMBDA_API_KEY"`,
    ]);
    expect(commands[0]?.destructive).toBe(true);
    expect(commands[0]?.placeholders?.map((p) => p.name)).toEqual(["LAMBDA_API_KEY"]);
  });

  it("keeps a hostile id inside the quoted URL", () => {
    expect(lines({ kind: "orphan", reason: "r", resource: res("filesystem", "a'b") })).toEqual([
      `! curl -sS -X DELETE 'https://cloud.lambda.ai/api/v1/filesystems/a'"'"'b' -H "Authorization: Bearer $LAMBDA_API_KEY"`,
    ]);
  });

  it("returns nothing for missing ids, other types and other kinds", () => {
    expect(lines({ kind: "orphan", reason: "r", resource: res("filesystem", null) })).toEqual([]);
    expect(lines({ kind: "orphan", reason: "r", resource: res("instance", "i-1") })).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("filesystem", "fs-1") })).toEqual([]);
  });
});
