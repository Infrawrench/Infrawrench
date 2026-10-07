import { describe, expect, it } from "vitest";
import type { RemediationFinding } from "@infrawrench/plugin-base";
import { gitlabRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

const orphan = (resourceTypeId: string, externalId: string | null): RemediationFinding => ({
  kind: "orphan",
  reason: "x",
  resource: { resourceTypeId, displayName: "thing", externalId, fields: {} },
});

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return gitlabRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);
}

describe("gitlabRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(gitlabRemediationCommands);
  });

  it("exports, then deletes an archived project", () => {
    const commands = gitlabRemediationCommands(orphan("project", "278964"));
    expect(commands.map((c) => `${c.destructive ? "!" : "-"} ${c.command}`)).toMatchInlineSnapshot(`
      [
        "- glab api -X POST --hostname "$GITLAB_HOST" projects/278964/export",
        "! glab api -X DELETE --hostname "$GITLAB_HOST" projects/278964",
      ]
    `);
    expect(commands[0]?.placeholders?.map((p) => p.name)).toEqual(["GITLAB_HOST"]);
  });

  it("deletes the scoped orphan types", () => {
    expect([
      ...lines(orphan("environment", "278964/12")),
      ...lines(orphan("container-repository", "278964/7")),
      ...lines(orphan("deploy-token", "278964/3")),
      ...lines(orphan("group-deploy-token", "9970/4")),
      ...lines(orphan("runner", "555")),
    ]).toMatchInlineSnapshot(`
      [
        "! glab api -X DELETE --hostname "$GITLAB_HOST" projects/278964/environments/12",
        "! glab api -X DELETE --hostname "$GITLAB_HOST" projects/278964/registry/repositories/7",
        "! glab api -X DELETE --hostname "$GITLAB_HOST" projects/278964/deploy_tokens/3",
        "! glab api -X DELETE --hostname "$GITLAB_HOST" groups/9970/deploy_tokens/4",
        "! glab api -X DELETE --hostname "$GITLAB_HOST" runners/555",
      ]
    `);
  });

  it("refuses ids that are not GitLab integers", () => {
    expect(lines(orphan("project", "1; rm -rf ~"))).toEqual([]);
    expect(lines(orphan("environment", "278964/x y"))).toEqual([]);
    expect(lines(orphan("runner", "1/2"))).toEqual([]);
  });

  it("returns nothing for missing ids, other types and other kinds", () => {
    expect(lines(orphan("project", null))).toEqual([]);
    expect(lines(orphan("environment", "278964"))).toEqual([]);
    expect(lines(orphan("pipeline", "278964/1"))).toEqual([]);
    expect(
      lines({
        kind: "sleep-schedule",
        resource: { resourceTypeId: "runner", displayName: "r", externalId: "555", fields: {} },
      }),
    ).toEqual([]);
  });
});
