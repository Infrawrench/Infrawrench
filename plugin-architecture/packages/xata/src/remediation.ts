import {
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

/**
 * Remediation for Xata savings findings: a branch's sleep schedule is
 * `curl` against the control-plane API, `PATCH` on the branch with
 * `{"hibernate": true|false}`, the same call this plugin's hibernate and wake
 * actions make. The Xata CLI can set the field (`xata branch set hibernate`),
 * but its docs do not state the accepted values, so the documented API call
 * is used instead of guessing them.
 *
 * References (verified 2026-10):
 * https://api.xata.tech/openapi.json
 *   (PATCH /organizations/{organizationID}/projects/{projectID}/branches/{branchID},
 *   BranchUpdateDetails.hibernate)
 * https://xata.io/docs/cli/branch
 */
export function xataRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  if (resource.resourceTypeId !== "xata-branch") return [];
  const parts = (resource.externalId ?? "").trim().split("/");
  const [idOrg = "", idProject = "", idBranch = ""] = parts.length === 3 ? parts : [];
  const org = remediationField(resource, "organizationId") || idOrg;
  const project = remediationField(resource, "projectId") || idProject;
  const branch = remediationField(resource, "branchId") || idBranch;
  if (!org || !project || !branch) return [];
  const url = `https://api.xata.tech/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/branches/${encodeURIComponent(branch)}`;
  return [
    patch(url, true, "Hibernate the branch; its compute stops billing until it is woken."),
    patch(url, false, "Wake the branch; it accepts connections again once its cluster is ready."),
  ];
}

const API_KEY: RemediationPlaceholder = {
  name: "XATA_API_KEY",
  description: "A Xata API key with access to this organization",
};

function patch(url: string, hibernate: boolean, description: string): RemediationCommand {
  return {
    tool: "curl",
    command:
      `curl -sS -X PATCH ${shellQuote(url)} -H "Authorization: Bearer $XATA_API_KEY"` +
      ` -H 'Content-Type: application/json' -d ${shellQuote(JSON.stringify({ hibernate }))}`,
    description,
    destructive: false,
    placeholders: [API_KEY],
  };
}
