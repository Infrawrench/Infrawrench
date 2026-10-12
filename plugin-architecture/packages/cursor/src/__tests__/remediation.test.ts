import { describe, expect, it } from "vitest";
import type { RemediationSeat, SeatRemediationFinding } from "@infrawrench/plugin-base";
import { cursorSeatRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function seat(overrides: Partial<RemediationSeat> = {}): RemediationSeat {
  return {
    memberId: "user_PDSPmvukpYgZEDXsoNirw3CFhy",
    seatKey: "",
    email: "ada@example.com",
    login: null,
    name: "Ada Lovelace",
    seatType: "Standard",
    targetSeatType: null,
    context: {},
    ...overrides,
  };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: SeatRemediationFinding): string[] {
  return cursorSeatRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

describe("cursorSeatRemediationCommands", () => {
  it("is wired on the plugin, and resource findings are no longer answered", () => {
    expect(plugin.seatRemediationCommands).toBe(cursorSeatRemediationCommands);
    expect(plugin.remediationCommands).toBeUndefined();
  });

  it("inspects, then removes an inactive member by user id", () => {
    const commands = cursorSeatRemediationCommands({ reason: "inactive", seat: seat() });
    expect(lines({ reason: "inactive", seat: seat() })).toMatchInlineSnapshot(`
      [
        "- curl -sS -X POST https://api.cursor.com/teams/spend -u "$CURSOR_API_KEY:" -H 'Content-Type: application/json' -d '{"searchTerm":"ada@example.com"}'",
        "- curl -sS -X POST https://api.cursor.com/teams/remove-member -u "$CURSOR_API_KEY:" -H 'Content-Type: application/json' -d '{"userId":"user_PDSPmvukpYgZEDXsoNirw3CFhy"}'",
      ]
    `);
    expect(commands.flatMap((c) => c.placeholders?.map((p) => p.name))).toEqual([
      "CURSOR_API_KEY",
      "CURSOR_API_KEY",
    ]);
  });

  it("falls back to the email for a duplicate, quoting it safely", () => {
    expect(
      lines({
        reason: "duplicate",
        seat: seat({ memberId: "o'brien@example.com", email: "o'brien@example.com" }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "- curl -sS -X POST https://api.cursor.com/teams/spend -u "$CURSOR_API_KEY:" -H 'Content-Type: application/json' -d '{"searchTerm":"o'"'"'brien@example.com"}'",
        "- curl -sS -X POST https://api.cursor.com/teams/remove-member -u "$CURSOR_API_KEY:" -H 'Content-Type: application/json' -d '{"email":"o'"'"'brien@example.com"}'",
      ]
    `);
  });

  it("points a downgrade at the dashboard, since no endpoint changes seat types", () => {
    const commands = cursorSeatRemediationCommands({
      reason: "downgrade",
      seat: seat({ seatType: "Premium", targetSeatType: "Standard" }),
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toContain("/teams/spend");
    expect(commands[0]!.description).toMatchInlineSnapshot(
      `"Show the member's role and spend this billing cycle before acting. Then move them to a Standard seat from the member's menu on the Members page of the Cursor dashboard; the change applies at the next renewal."`,
    );
  });

  it("returns nothing without an id or email", () => {
    expect(lines({ reason: "inactive", seat: seat({ memberId: "m1", email: null }) })).toEqual([]);
  });
});
