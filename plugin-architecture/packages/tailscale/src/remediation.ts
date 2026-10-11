import {
  type RemediationCommand,
  type RemediationPlaceholder,
  type SeatRemediationFinding,
} from "@infrawrench/plugin-base";

const API = "https://api.tailscale.com/api/v2";

/**
 * Remediation for Tailscale seat findings, as `curl` against the API (the
 * `tailscale` CLI manages the local node, not tailnet users).
 *
 * - Inactive or duplicate: show the user (status, last seen, devices), then
 *   suspend them, which frees the seat and is undone with Restore. Deleting
 *   (`POST /users/{id}/delete`) also frees it but removes their devices for
 *   good, so it is not offered.
 * - Downgrade: never produced; the API does not report the plan.
 *
 * Routes from https://api.tailscale.com/api/v2?outputOpenapiSchema=true
 * (getUser, suspendUser); effects from
 * https://tailscale.com/docs/features/sharing/how-to/remove-team-members.
 */
export function tailscaleSeatRemediationCommands(
  finding: SeatRemediationFinding,
): RemediationCommand[] {
  if (finding.reason === "downgrade") return [];
  const id = finding.seat.memberId.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return [];
  const who = finding.seat.login ?? finding.seat.email ?? id;
  return [
    {
      tool: "curl",
      command: `curl -sS --fail-with-body ${API}/users/${id} -H "Authorization: Bearer $TAILSCALE_API_KEY"`,
      description: `Show ${who}'s status, last seen time and device count before suspending.`,
      destructive: false,
      placeholders: [API_KEY],
    },
    {
      tool: "curl",
      command: `curl -sS --fail-with-body -X POST ${API}/users/${id}/suspend -H "Authorization: Bearer $TAILSCALE_API_KEY"`,
      description:
        "Suspend the user to free the seat; their devices stay but cannot exchange traffic, and Restore undoes it. Then lower the seat count in billing, or Tailscale keeps charging for the empty seat.",
      destructive: false,
      placeholders: [API_KEY],
    },
  ];
}

const API_KEY: RemediationPlaceholder = {
  name: "TAILSCALE_API_KEY",
  description: "A Tailscale API access token, or an OAuth access token with the users scope",
};
