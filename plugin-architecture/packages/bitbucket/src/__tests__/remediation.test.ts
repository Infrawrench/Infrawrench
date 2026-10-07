import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { bitbucketRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "x", externalId, fields };
}

function orphan(resource: RemediationResource): RemediationFinding {
  return { kind: "orphan", reason: "r", resource };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return bitbucketRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

const AUTH = `-u "$ATLASSIAN_EMAIL:$BITBUCKET_API_TOKEN"`;

describe("bitbucketRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(bitbucketRemediationCommands);
  });

  it("deletes a never-used deploy key", () => {
    const commands = bitbucketRemediationCommands(
      orphan(res("deploy-key", "web-app/123", { repository: "web-app" })),
    );
    expect(commands.map((c) => c.command)).toEqual([
      `curl -sS -X DELETE "https://api.bitbucket.org/2.0/repositories/$BITBUCKET_WORKSPACE"/web-app/deploy-keys/123 ${AUTH}`,
    ]);
    expect(commands[0]?.destructive).toBe(true);
    expect(commands[0]?.placeholders?.map((p) => p.name)).toEqual([
      "BITBUCKET_WORKSPACE",
      "ATLASSIAN_EMAIL",
      "BITBUCKET_API_TOKEN",
    ]);
  });

  it("deletes workspace and repository runners, braces encoded", () => {
    expect(lines(orphan(res("runner", "workspace/{ab-12}")))).toEqual([
      `! curl -sS -X DELETE "https://api.bitbucket.org/2.0/workspaces/$BITBUCKET_WORKSPACE"/pipelines-config/runners/%7Bab-12%7D ${AUTH}`,
    ]);
    expect(lines(orphan(res("runner", "repo:web-app/ab-12")))).toEqual([
      `! curl -sS -X DELETE "https://api.bitbucket.org/2.0/repositories/$BITBUCKET_WORKSPACE"/web-app/pipelines-config/runners/%7Bab-12%7D ${AUTH}`,
    ]);
  });

  it("keeps a hostile slug out of shell syntax", () => {
    expect(lines(orphan(res("deploy-key", "x/1", { repository: "a'$(id)" })))).toEqual([
      `! curl -sS -X DELETE "https://api.bitbucket.org/2.0/repositories/$BITBUCKET_WORKSPACE"'/a'"'"'%24(id)/deploy-keys/1' ${AUTH}`,
    ]);
  });

  it("returns nothing for missing ids, other types and other kinds", () => {
    expect(lines(orphan(res("deploy-key", null)))).toEqual([]);
    expect(lines(orphan(res("deploy-key", "no-slash")))).toEqual([]);
    expect(lines(orphan(res("runner", null)))).toEqual([]);
    expect(lines(orphan(res("project-deploy-key", "PRJ/1")))).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("runner", "workspace/{ab-12}") })).toEqual(
      [],
    );
  });
});
