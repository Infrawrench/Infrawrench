import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { cursorRemediationCommands } from "../remediation.js";
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
  displayName = "Ada Lovelace",
): RemediationResource {
  return { resourceTypeId, displayName, externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return cursorRemediationCommands(finding).map((c) => `${c.destructive ? "!" : "-"} ${c.command}`);
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "idle seat",
  resource,
});

describe("cursorRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(cursorRemediationCommands);
  });

  it("removes an idle member by user id", () => {
    const commands = cursorRemediationCommands(
      orphan(
        res("team-member", "user_PDSPmvukpYgZEDXsoNirw3CFhy", {
          email: "ada@example.com",
          seatStatus: "idle",
        }),
      ),
    );
    expect(commands.map((c) => c.command)).toMatchInlineSnapshot(`
      [
        "curl -sS -X POST https://api.cursor.com/teams/remove-member -u "$CURSOR_API_KEY:" -H 'Content-Type: application/json' -d '{"userId":"user_PDSPmvukpYgZEDXsoNirw3CFhy"}'",
      ]
    `);
    expect(commands[0]?.placeholders?.map((p) => p.name)).toEqual(["CURSOR_API_KEY"]);
  });

  it("falls back to the email, quoting it safely", () => {
    expect(
      lines(
        orphan(
          res("team-member", "o'brien@example.com", {
            email: "o'brien@example.com",
            seatStatus: "idle",
          }),
        ),
      ),
    ).toMatchInlineSnapshot(`
      [
        "- curl -sS -X POST https://api.cursor.com/teams/remove-member -u "$CURSOR_API_KEY:" -H 'Content-Type: application/json' -d '{"email":"o'"'"'brien@example.com"}'",
      ]
    `);
  });

  it("returns nothing for unknown types and other kinds", () => {
    expect(lines(orphan(res("billing-group", "grp_1")))).toEqual([]);
    expect(lines(orphan(res("team-member", "", {})))).toEqual([]);
    expect(lines({ kind: "sleep-schedule", resource: res("team-member", "user_1") })).toEqual([]);
  });
});
