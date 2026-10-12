import {
  shellQuote,
  type RemediationCommand,
  type RemediationPlaceholder,
  type SeatRemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Remediation for Okta seat findings, as `curl` against the Management API
 * with an SSWS API token. Okta has no official admin CLI for user lifecycle.
 *
 * - Inactive or duplicate: show the user (status, last sign-in, activation
 *   date), then deactivate them, which frees the licence and deprovisions
 *   every app assignment.
 * - Downgrade: never produced; Okta's API does not expose the suite, so the
 *   plugin cannot justify a cheaper tier.
 *
 * Get a user: https://developer.okta.com/docs/api/openapi/okta-management/management/tag/User/#tag/User/operation/getUser
 * Deactivate a user: https://developer.okta.com/docs/api/openapi/okta-management/management/tag/User/#tag/User/operation/deactivateUser
 */
export function oktaSeatRemediationCommands(finding: SeatRemediationFinding): RemediationCommand[] {
  if (finding.reason === "downgrade") return [];
  const { seat } = finding;
  const id = seat.memberId.trim();
  if (!id) return [];
  const orgUrl = (seat.context["orgUrl"] ?? "").trim().replace(/\/+$/, "");
  const base = orgUrl ? orgUrl : "$OKTA_ORG_URL";
  const placeholders = orgUrl ? [API_TOKEN] : [API_TOKEN, ORG_URL];
  const userUrl = `${base}/api/v1/users/${encodeURIComponent(id)}`;
  const url = (path: string) => (orgUrl ? shellQuote(path) : `"${path}"`);
  const who = seat.email ?? seat.login ?? id;
  return [
    {
      tool: "curl",
      command: `curl -sS --fail-with-body ${url(userUrl)} -H "Authorization: SSWS $OKTA_API_TOKEN" -H 'Accept: application/json'`,
      description: `Show ${who}'s status, last sign-in and activation date before deactivating.`,
      destructive: false,
      placeholders,
    },
    {
      tool: "curl",
      command: `curl -sS --fail-with-body -X POST ${url(`${userUrl}/lifecycle/deactivate`)} -H "Authorization: SSWS $OKTA_API_TOKEN" -H 'Accept: application/json'`,
      description:
        "Deactivate the user to free the licence. Okta deprovisions every app assignment, which can delete their data in those apps; reactivating later does not restore the assignments.",
      destructive: true,
      placeholders,
    },
  ];
}

const API_TOKEN: RemediationPlaceholder = {
  name: "OKTA_API_TOKEN",
  description:
    "An Okta API token from an admin allowed to manage users (Security, API, Tokens in the Admin Console)",
};

const ORG_URL: RemediationPlaceholder = {
  name: "OKTA_ORG_URL",
  description: "Your Okta org's address, e.g. https://acme.okta.com",
};
