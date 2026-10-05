import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { githubRemediationCommands } from "../remediation.js";
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
  displayName = "octocat",
): RemediationResource {
  return { resourceTypeId, displayName, externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return githubRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "unused",
  resource,
});

describe("githubRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(githubRemediationCommands);
  });

  it("cancels a directly assigned idle Copilot seat", () => {
    expect(
      lines(
        orphan(
          res("copilot-seat", "octocat", {
            login: "octocat",
            organization: "octo-org",
            idle: true,
          }),
        ),
      ),
    ).toMatchInlineSnapshot(`
      [
        "- gh api "/orgs/octo-org/members/octocat/copilot"",
        "- gh api --method DELETE "/orgs/octo-org/copilot/billing/selected_users" -f 'selected_usernames[]=octocat'",
      ]
    `);
  });

  it("only inspects a seat that comes from a team", () => {
    const commands = githubRemediationCommands(
      orphan(res("copilot-seat", "octocat", { login: "octocat", assigningTeam: "platform" })),
    );
    expect(commands.map((c) => c.command)).toMatchInlineSnapshot(`
      [
        "gh api "/orgs/$GITHUB_ORG/members/octocat/copilot"",
      ]
    `);
    expect(commands[0]?.placeholders?.map((p) => p.name)).toEqual(["GITHUB_ORG"]);
  });

  it("removes an offline self-hosted runner", () => {
    expect(lines(orphan(res("runner", "42", { name: "build-01", status: "offline" }))))
      .toMatchInlineSnapshot(`
      [
        "- gh api "/orgs/$GITHUB_ORG/actions/runners/42"",
        "! gh api --method DELETE "/orgs/$GITHUB_ORG/actions/runners/42"",
      ]
    `);
  });

  it("deletes a stale codespace, quoting its owner", () => {
    expect(
      lines(
        orphan(
          res("codespace", "mona'; rm -rf ~/monalisa-octocat-r65vq7x7f5jqx", {
            owner: "mona'; rm -rf ~",
            codespaceName: "monalisa-octocat-r65vq7x7f5jqx",
            stale: true,
          }),
        ),
      ),
    ).toMatchInlineSnapshot(`
      [
        "! gh codespace delete --org "$GITHUB_ORG" --user 'mona'"'"'; rm -rf ~' --codespace monalisa-octocat-r65vq7x7f5jqx",
      ]
    `);
  });

  it("returns nothing for unknown types, bad ids and other kinds", () => {
    expect(lines(orphan(res("actions-cache", "octo-org/app")))).toEqual([]);
    expect(lines(orphan(res("runner", "not-a-number")))).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("codespace", "a/b") })).toEqual([]);
  });
});
