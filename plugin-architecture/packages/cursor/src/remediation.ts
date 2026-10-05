import {
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

/**
 * Remediation for Cursor savings findings. Cursor has no CLI for team
 * administration, so the command is `curl` against the Admin API, which
 * authenticates with HTTP Basic: the team API key as the username and an
 * empty password.
 *
 * Reference: https://cursor.com/docs/account/teams/admin-api
 */
export function cursorRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan") return [];
  const { resource } = finding;
  if (resource.resourceTypeId !== "team-member") return [];
  // remove-member takes exactly one of userId or email; the lister stores the
  // user id when Cursor returns one and falls back to the email otherwise.
  const id = remediationId(resource);
  const email = remediationField(resource, "email");
  const body = id.startsWith("user_") ? { userId: id } : email ? { email } : null;
  if (!body) return [];
  return [
    {
      tool: "curl",
      command: `curl -sS -X POST https://api.cursor.com/teams/remove-member -u "$CURSOR_API_KEY:" -H 'Content-Type: application/json' -d ${shellQuote(JSON.stringify(body))}`,
      description:
        "Remove the idle member from the team; Cursor bills the seat until the end of the cycle, and they can be invited again later.",
      destructive: false,
      placeholders: [API_KEY],
    },
  ];
}

const API_KEY: RemediationPlaceholder = {
  name: "CURSOR_API_KEY",
  description: "A Cursor Admin API key for this team, created in the team dashboard",
};
