import {
  shellQuote,
  type RemediationCommand,
  type RemediationPlaceholder,
  type SeatRemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Remediation for Claude Enterprise seat findings. There is no Anthropic CLI
 * for organization administration, so the commands are `curl` against the
 * Admin API with the Admin key in `x-api-key` and the mandatory
 * `anthropic-version` header.
 *
 * Reference: https://platform.claude.com/docs/en/manage-claude/user-management
 */
export function anthropicSeatRemediationCommands(
  finding: SeatRemediationFinding,
): RemediationCommand[] {
  // Claude Enterprise has one seat type through the API, so a downgrade is never reported.
  if (finding.reason === "downgrade") return [];
  const id = finding.seat.memberId.trim();
  if (!id) return [];
  const url = shellQuote(
    `https://api.anthropic.com/v1/organizations/users/${encodeURIComponent(id)}`,
  );
  const headers = `-H "x-api-key: $ANTHROPIC_ADMIN_KEY" -H 'anthropic-version: 2023-06-01'`;
  return [
    {
      tool: "curl",
      // GET /v1/organizations/users/{user_id}
      command: `curl -sS ${url} ${headers}`,
      description: "Show the member's email, role and join date before removing them.",
      destructive: false,
      placeholders: [ADMIN_KEY],
    },
    {
      tool: "curl",
      // DELETE /v1/organizations/users/{user_id}
      command: `curl -sS -X DELETE ${url} ${headers}`,
      description:
        "Remove the member from the organization; their seat returns to the pool, so lower the seat count in claude.ai billing to stop paying for it. They can be invited again later.",
      destructive: false,
      placeholders: [ADMIN_KEY],
    },
  ];
}

const ADMIN_KEY: RemediationPlaceholder = {
  name: "ANTHROPIC_ADMIN_KEY",
  description:
    "An Admin API key for this Claude Enterprise organization with the write:members scope, created in claude.ai organization settings",
};
