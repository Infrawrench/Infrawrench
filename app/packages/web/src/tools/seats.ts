/**
 * Seats tool: the MCP/chat view of the Savings tab's Seats section. Read-only;
 * removing a seat is a provider-account change done from the app or the
 * `POST /seats/{seatId}/remove` route, where the change freeze and the audit
 * row live.
 */
import { z } from "zod";
import type { SeatFindingKind } from "@infrawrench/client-core";
import { listSeats } from "@infrawrench/server-core/seats/feed";
import { ok, type ToolDefinition } from "./types";

export function seatTools(): ToolDefinition[] {
  return [
    {
      name: "list_seat_findings",
      title: "List SaaS seat findings",
      description:
        "Paid SaaS seats (GitHub Copilot, Cursor, GitLab, Okta, Claude Enterprise, Docker Hub, " +
        "Tailscale) worth acting on: `inactive` (no use for the org's `inactiveDays`), " +
        "`duplicate` (the same person, by email, paying for two tools in one category; the " +
        "seat used most recently is kept), and `downgrade` (a cheaper tier the usage fits). " +
        "Each finding gives `monthlySaving` and remediation commands; `seats` lists every seat " +
        "with its last activity and `activityBasis` (how activity was determined; `none` is " +
        "never flagged). `savingsMonthly` totals the findings.",
      inputSchema: {
        kind: z
          .enum(["inactive", "duplicate", "downgrade"])
          .optional()
          .describe("Only return findings of this kind."),
        includeAllSeats: z
          .boolean()
          .optional()
          .describe("Return every seat, not only the ones a finding is about."),
      },
      risk: "read",
      // Mirrors `GET /seats`.
      permission: "costs:read",
      handler: async (input, auth) => {
        const { kind, includeAllSeats } = input as {
          kind?: SeatFindingKind;
          includeAllSeats?: boolean;
        };
        const list = await listSeats(auth.organizationId);
        const findings = kind ? list.findings.filter((f) => f.kind === kind) : list.findings;
        const ids = new Set(findings.map((f) => f.seatId));
        // Totals and counts stay whole-list so a filtered answer still shows
        // the overall picture: the list_posture_findings stance.
        return ok({
          ...list,
          findings,
          seats: includeAllSeats ? list.seats : list.seats.filter((s) => ids.has(s.id)),
        });
      },
    },
  ];
}
