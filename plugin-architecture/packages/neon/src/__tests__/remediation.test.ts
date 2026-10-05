import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { neonRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
  displayName = "ep-cool-darkness-123456.us-east-2.aws.neon.tech",
): RemediationResource {
  return { resourceTypeId, displayName, externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return neonRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);
}

describe("neonRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(neonRemediationCommands);
  });

  it("suspends and starts a compute endpoint", () => {
    const commands = neonRemediationCommands({
      kind: "sleep-schedule",
      resource: res("neon-endpoint", "ep-cool-darkness-123456", {
        projectId: "silent-cloud-96841203",
        branchId: "br-wispy-meadow-118737",
        currentState: "active",
      }),
    });
    expect(commands.map((c) => c.command)).toMatchInlineSnapshot(`
      [
        "curl -sS -X POST https://console.neon.tech/api/v2/projects/silent-cloud-96841203/endpoints/ep-cool-darkness-123456/suspend -H "Authorization: Bearer $NEON_API_KEY"",
        "curl -sS -X POST https://console.neon.tech/api/v2/projects/silent-cloud-96841203/endpoints/ep-cool-darkness-123456/start -H "Authorization: Bearer $NEON_API_KEY"",
      ]
    `);
    expect(commands[0]?.placeholders?.map((p) => p.name)).toEqual(["NEON_API_KEY"]);
  });

  it("keeps a project id with shell metacharacters inside the quoted URL", () => {
    expect(
      lines({
        kind: "sleep-schedule",
        resource: res("neon-endpoint", "ep-cool-darkness-123456", { projectId: "p'; rm -rf ~" }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- curl -sS -X POST 'https://console.neon.tech/api/v2/projects/p'"'"'%3B%20rm%20-rf%20~/endpoints/ep-cool-darkness-123456/suspend' -H "Authorization: Bearer $NEON_API_KEY"",
        "- curl -sS -X POST 'https://console.neon.tech/api/v2/projects/p'"'"'%3B%20rm%20-rf%20~/endpoints/ep-cool-darkness-123456/start' -H "Authorization: Bearer $NEON_API_KEY"",
      ]
    `);
  });

  it("returns nothing for unknown types, missing ids and other kinds", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("neon-branch", "br-1") })).toEqual([]);
    expect(
      lines({ kind: "sleep-schedule", resource: res("neon-endpoint", "ep-cool-darkness-123456") }),
    ).toEqual([]);
    expect(
      lines({
        kind: "orphan",
        reason: "x",
        resource: res("neon-endpoint", "ep-1", { projectId: "p" }),
      }),
    ).toEqual([]);
  });
});
