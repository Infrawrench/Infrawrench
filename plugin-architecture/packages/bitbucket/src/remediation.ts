import {
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";
import { parseRunnerId } from "./mappers.js";

/**
 * Remediation for Bitbucket Cloud savings findings. Atlassian ships no
 * official Bitbucket Cloud CLI, so the commands are `curl` against REST API
 * 2.0, the same DELETE routes the plugin's own delete calls:
 *
 * - a never-used repository deploy key:
 *   `DELETE /repositories/{workspace}/{repo_slug}/deploy-keys/{key_id}`
 * - a runner that was created but never started:
 *   `DELETE /workspaces/{workspace}/pipelines-config/runners/{runner_uuid}` or
 *   the `/repositories/{workspace}/{repo_slug}/...` form for a repository runner.
 *
 * The workspace is account configuration, not a stored field, so it is a
 * placeholder. Auth is HTTP Basic with the Atlassian email and a scoped API
 * token, as the plugin itself sends it.
 *
 * Reference: https://api.bitbucket.org/swagger.json (paths above, 2026-10) and
 * https://developer.atlassian.com/cloud/bitbucket/rest/api-group-deployments/
 */
export function bitbucketRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan") return [];
  const { resource } = finding;
  const externalId = (resource.externalId ?? "").trim();

  if (resource.resourceTypeId === "deploy-key") {
    const slash = externalId.indexOf("/");
    const keyId = slash < 0 ? "" : externalId.slice(slash + 1);
    const slug =
      remediationField(resource, "repository") || (slash < 0 ? "" : externalId.slice(0, slash));
    if (!slug || !keyId) return [];
    return [
      del(
        `/repositories/`,
        `/${enc(slug)}/deploy-keys/${enc(keyId)}`,
        "Remove the deploy key from the repository; anything still using it loses read access.",
      ),
    ];
  }

  if (resource.resourceTypeId === "runner") {
    if (!externalId) return [];
    const { slug, uuid } = parseRunnerId(externalId);
    if (!uuid.trim() || slug === "") return [];
    const path = `/pipelines-config/runners/${encUuid(uuid)}`;
    return [
      slug
        ? del(
            `/repositories/`,
            `/${enc(slug)}${path}`,
            "Delete the never-started repository runner.",
          )
        : del(`/workspaces/`, path, "Delete the never-started workspace runner."),
    ];
  }

  return [];
}

const API = "https://api.bitbucket.org/2.0";
const enc = encodeURIComponent;

/** `{uuid}` in a path, braces added when the stored value lacks them. */
function encUuid(uuid: string): string {
  const v = uuid.trim();
  return enc(v.startsWith("{") ? v : `{${v}}`);
}

const PLACEHOLDERS: RemediationPlaceholder[] = [
  { name: "BITBUCKET_WORKSPACE", description: "The Bitbucket workspace slug this account is for" },
  { name: "ATLASSIAN_EMAIL", description: "The email you sign in to Atlassian with" },
  {
    name: "BITBUCKET_API_TOKEN",
    description: "An Atlassian API token with Bitbucket admin scopes for this workspace",
  },
];

/**
 * One DELETE. The workspace expands inside double quotes; the rest of the
 * path is percent-encoded and shell-quoted on its own, so nothing a stored id
 * holds is read as shell syntax.
 */
function del(prefix: string, rest: string, description: string): RemediationCommand {
  return {
    tool: "curl",
    command: `curl -sS -X DELETE "${API}${prefix}$BITBUCKET_WORKSPACE"${shellQuote(rest)} -u "$ATLASSIAN_EMAIL:$BITBUCKET_API_TOKEN"`,
    description,
    destructive: true,
    placeholders: PLACEHOLDERS,
  };
}
