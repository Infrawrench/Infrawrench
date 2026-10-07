import {
  remediationField,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
  type RemediationResource,
} from "@infrawrench/plugin-base";

/**
 * Remediation for HCP Terraform / Terraform Enterprise savings findings. There
 * is no official CLI for these API objects, so every command is `curl` against
 * the documented v2 API, the same routes this plugin's own deletes call. The
 * hostname is account-level (HCP, HCP Europe or a TFE install), so it is a
 * placeholder like the token.
 *
 * - An empty, never-run workspace (orphan): safe-delete it, which refuses while
 *   the workspace still manages resources.
 * - An exited agent (orphan): delete it from its pool's list.
 * - A never-used agent token (orphan): delete (revoke) it.
 *
 * References:
 * https://developer.hashicorp.com/terraform/cloud-docs/api-docs/workspaces#safe-delete-a-workspace
 * https://developer.hashicorp.com/terraform/cloud-docs/api-docs/agents#delete-an-agent
 * https://developer.hashicorp.com/terraform/cloud-docs/api-docs/agent-tokens#destroy-an-agent-token
 */
export function tfeRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan") return [];
  const { resource } = finding;

  if (resource.resourceTypeId === "workspace") {
    const id = (resource.externalId ?? "").trim();
    if (!id) return [];
    return [
      request(
        "POST",
        `/workspaces/${encodeURIComponent(id)}/actions/safe-delete`,
        "Safe-delete the workspace. It is refused if the workspace manages any resources.",
      ),
    ];
  }

  if (resource.resourceTypeId === "agent") {
    const id = childId(resource, "agentId");
    if (!id) return [];
    return [
      request(
        "DELETE",
        `/agents/${encodeURIComponent(id)}`,
        "Remove the exited agent from its pool.",
      ),
    ];
  }

  if (resource.resourceTypeId === "agent-token") {
    const id = childId(resource, "tokenId");
    if (!id) return [];
    return [
      request(
        "DELETE",
        `/authentication-tokens/${encodeURIComponent(id)}`,
        "Revoke the unused agent token.",
      ),
    ];
  }

  return [];
}

const PLACEHOLDERS: RemediationPlaceholder[] = [
  {
    name: "TFE_HOSTNAME",
    description: "app.terraform.io, app.eu.terraform.io, or your Terraform Enterprise hostname",
  },
  { name: "TFE_TOKEN", description: "An HCP Terraform API token for this organization" },
];

/** The id field, else the second half of a `<poolId>/<id>` externalId. */
function childId(resource: RemediationResource, key: string): string {
  const fromField = remediationField(resource, key);
  if (fromField) return fromField;
  const [, id = ""] = (resource.externalId ?? "").split("/");
  return id.trim();
}

/**
 * One API call, always destructive here. Ids are percent-encoded; the URL is
 * double-quoted so `$TFE_HOSTNAME` expands, which is safe because an encoded id
 * holds no `"`, `$`, backtick or backslash.
 */
function request(method: "POST" | "DELETE", path: string, description: string): RemediationCommand {
  return {
    tool: "curl",
    command:
      `curl -sS -X ${method} "https://$TFE_HOSTNAME/api/v2${path}"` +
      ` -H "Authorization: Bearer $TFE_TOKEN" -H 'Content-Type: application/vnd.api+json'`,
    description,
    destructive: true,
    placeholders: PLACEHOLDERS,
  };
}
