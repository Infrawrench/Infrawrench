import {
  shellQuote,
  type RemediationCommand,
  type RemediationPlaceholder,
  type SeatRemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Remediation for Cursor seat findings (inactive, duplicate, downgrade).
 * Cursor has no CLI for team administration, so the commands are `curl`
 * against the Admin API, which authenticates with HTTP Basic: the team API key
 * as the username and an empty password.
 *
 * Idle seats used to be an orphan rule on the `team-member` resource; the
 * seat finder owns them now (with the org's own inactivity threshold), so this
 * plugin no longer answers resource findings at all.
 *
 * Reference: https://cursor.com/docs/account/teams/admin-api
 */
export function cursorSeatRemediationCommands(
  finding: SeatRemediationFinding,
): RemediationCommand[] {
  const { seat } = finding;
  const email = seat.email?.trim() || null;
  // remove-member takes exactly one of userId or email; the seat's memberId is
  // the encoded `user_...` id when Cursor returned one, else the email.
  const body = seat.memberId.startsWith("user_")
    ? { userId: seat.memberId }
    : email
      ? { email }
      : null;
  if (!body) return [];

  const inspect: RemediationCommand[] = email
    ? [
        {
          tool: "curl",
          // https://cursor.com/docs/account/teams/admin-api (POST /teams/spend, searchTerm)
          command: `curl -sS -X POST https://api.cursor.com/teams/spend -u "$CURSOR_API_KEY:" -H 'Content-Type: application/json' -d ${shellQuote(JSON.stringify({ searchTerm: email }))}`,
          description: "Show the member's role and spend this billing cycle before acting.",
          destructive: false,
          placeholders: [API_KEY],
        },
      ]
    : [];

  if (finding.reason === "downgrade") {
    // No endpoint changes a seat type; Cursor documents it as a dashboard action.
    return inspect.map((c) => ({
      ...c,
      description: `${c.description} Then move them to a ${seat.targetSeatType ?? "Standard"} seat from the member's menu on the Members page of the Cursor dashboard; the change applies at the next renewal.`,
    }));
  }

  return [
    ...inspect,
    {
      tool: "curl",
      // https://cursor.com/docs/account/teams/admin-api (POST /teams/remove-member, Enterprise only)
      command: `curl -sS -X POST https://api.cursor.com/teams/remove-member -u "$CURSOR_API_KEY:" -H 'Content-Type: application/json' -d ${shellQuote(JSON.stringify(body))}`,
      description:
        "Remove the member from the team (Enterprise plans; on Teams use the dashboard). A member who used credits this cycle keeps the seat billed until it ends, and they can be invited again later.",
      destructive: false,
      placeholders: [API_KEY],
    },
  ];
}

const API_KEY: RemediationPlaceholder = {
  name: "CURSOR_API_KEY",
  description: "A Cursor Admin API key with the admin scope, created in the team dashboard",
};
