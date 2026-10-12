import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  RemediationFinding,
  RemediationResource,
  RemediationSeat,
  SeatRemediationFinding,
} from "@infrawrench/plugin-base";
import { githubRemediationCommands, githubSeatRemediationCommands } from "../remediation.js";
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
    expect(lines(orphan(res("copilot-seat", "octocat", { login: "octocat" })))).toEqual([]);
    expect(lines(orphan(res("runner", "not-a-number")))).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("codespace", "a/b") })).toEqual([]);
  });
});

function seat(context: Record<string, string>, login: string | null = "octocat"): RemediationSeat {
  return {
    memberId: "1",
    seatKey: "",
    email: null,
    login,
    name: null,
    seatType: "Copilot Business",
    targetSeatType: null,
    context,
  };
}

function seatLines(finding: SeatRemediationFinding): string[] {
  return githubSeatRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

describe("githubSeatRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.seatRemediationCommands).toBe(githubSeatRemediationCommands);
  });

  it("inspects, then cancels an inactive org seat", () => {
    expect(
      seatLines({
        reason: "inactive",
        seat: seat({ ownerKind: "org", owner: "octo-org", organization: "octo-org" }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- gh api "/orgs/octo-org/members/octocat/copilot"",
        "- gh api --method DELETE "/orgs/octo-org/copilot/billing/selected_users" -f 'selected_usernames[]=octocat'",
      ]
    `);
  });

  it("cancels a duplicate enterprise-level seat on the enterprise", () => {
    expect(
      seatLines({ reason: "duplicate", seat: seat({ ownerKind: "enterprise", owner: "big" }) }),
    ).toMatchInlineSnapshot(`
      [
        "- gh api "/enterprises/big/members/octocat/copilot"",
        "- gh api --method DELETE "/enterprises/big/copilot/billing/selected_users" -f 'selected_usernames[]=octocat'",
      ]
    `);
  });

  it("only inspects a team seat, and falls back to a placeholder org", () => {
    const commands = githubSeatRemediationCommands({
      reason: "inactive",
      seat: seat({ team: "platform" }),
    });
    expect(commands.map((c) => c.command)).toMatchInlineSnapshot(`
      [
        "gh api "/orgs/$GITHUB_ORG/members/octocat/copilot"",
      ]
    `);
    expect(commands[0]?.description).toMatch(/platform team/);
    expect(commands[0]?.placeholders?.map((p) => p.name)).toEqual(["GITHUB_ORG"]);
  });

  it("quotes the login and answers nothing for downgrades or a missing login", () => {
    expect(seatLines({ reason: "inactive", seat: seat({ organization: "o" }, "a'b") }))
      .toMatchInlineSnapshot(`
      [
        "- gh api "/orgs/o/members/a'b/copilot"",
        "- gh api --method DELETE "/orgs/o/copilot/billing/selected_users" -f 'selected_usernames[]=a'"'"'b'",
      ]
    `);
    expect(seatLines({ reason: "downgrade", seat: seat({ organization: "o" }) })).toEqual([]);
    expect(seatLines({ reason: "inactive", seat: seat({ organization: "o" }, null) })).toEqual([]);
  });
});
