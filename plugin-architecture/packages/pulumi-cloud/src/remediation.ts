import {
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

/**
 * Remediation for Pulumi Cloud savings findings (both are orphans):
 *
 * - An empty stack (no resources): `pulumi stack rm`, addressed by its fully
 *   qualified `org/project/stack` name so it runs from any directory. Without
 *   `--force` Pulumi refuses if the stack still has resources, which is the
 *   safety net we want.
 * - A never-used organization token: the CLI cannot manage org tokens, so it
 *   is `curl` against the REST API's `DELETE /api/orgs/{org}/tokens/{tokenId}`.
 *
 * References:
 * https://www.pulumi.com/docs/iac/cli/commands/pulumi_stack_rm/
 * https://api.pulumi.com/api/openapi/pulumi-spec.json (DELETE /api/orgs/{orgName}/tokens/{tokenId})
 */
export function pulumiCloudRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan") return [];
  const { resource } = finding;

  if (resource.resourceTypeId === "stack") {
    const fqn = remediationField(resource, "fullyQualifiedName");
    if (fqn.split("/").filter(Boolean).length !== 3) return [];
    return [
      {
        tool: "pulumi",
        command: `pulumi stack rm --yes --preserve-config --stack ${shellQuote(fqn)}`,
        description:
          "Delete the empty stack and its update history from Pulumi Cloud; Pulumi refuses if it still manages resources.",
        destructive: true,
      },
    ];
  }

  if (resource.resourceTypeId === "access-token") {
    const org = remediationField(resource, "organization");
    const tokenId = remediationId(resource, "tokenId");
    if (!org || !tokenId) return [];
    const url = `https://api.pulumi.com/api/orgs/${encodeURIComponent(org)}/tokens/${encodeURIComponent(tokenId)}`;
    return [
      {
        tool: "curl",
        command: `curl -sS -X DELETE ${shellQuote(url)} -H "Authorization: token $PULUMI_ACCESS_TOKEN"`,
        description:
          "Revoke the never-used organization token. On a self-hosted Pulumi Cloud, swap api.pulumi.com for your API host.",
        destructive: true,
        placeholders: PLACEHOLDERS,
      },
    ];
  }

  return [];
}

const PLACEHOLDERS: RemediationPlaceholder[] = [
  {
    name: "PULUMI_ACCESS_TOKEN",
    description: "A Pulumi Cloud access token with admin rights on this organization",
  },
];
