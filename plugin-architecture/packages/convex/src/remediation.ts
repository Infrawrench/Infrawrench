import {
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

/**
 * Remediation for Convex savings findings. The Convex CLI has no pause or
 * unpause (`npx convex deployment` is select, create, token, usage and
 * usage-limits), so a deployment's sleep schedule is `curl` against the
 * deployment's own Deployment API, the same calls this plugin's actions make.
 * A paused deployment still bills storage, but not function calls or
 * bandwidth.
 *
 * References (verified 2026-10):
 * https://docs.convex.dev/cli/reference/deployment
 * https://docs.convex.dev/deployment-api/pause-deployment
 * https://docs.convex.dev/deployment-api/unpause-deployment
 * https://github.com/get-convex/convex-backend/blob/main/npm-packages/%40convex-dev/platform/deployment-openapi.json
 *   (server `{deployment-url}/api/v1`, `Authorization: Convex <key>`)
 */
export function convexRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  if (resource.resourceTypeId !== "convex-deployment") return [];
  const base = deploymentApiBase(
    remediationField(resource, "deploymentUrl"),
    remediationId(resource, "name"),
  );
  if (!base) return [];
  return [
    curl(
      `${base}/pause_deployment`,
      "Pause the deployment; function calls fail and crons are skipped until it is unpaused, and only storage keeps billing.",
    ),
    curl(`${base}/unpause_deployment`, "Unpause the deployment."),
  ];
}

/** `{deploymentUrl}/api/v1`, from the stored URL or else the deployment name. */
function deploymentApiBase(url: string, name: string): string {
  if (/^https:\/\/[^\s/?#]+\/?$/.test(url)) return `${url.replace(/\/+$/, "")}/api/v1`;
  if (/^[a-z0-9-]+$/.test(name)) return `https://${name}.convex.cloud/api/v1`;
  return "";
}

const DEPLOY_KEY: RemediationPlaceholder = {
  name: "CONVEX_DEPLOY_KEY",
  description: "A deploy key for this deployment, or a team access token",
};

function curl(url: string, description: string): RemediationCommand {
  return {
    tool: "curl",
    command: `curl -sS -X POST ${shellQuote(url)} -H "Authorization: Convex $CONVEX_DEPLOY_KEY"`,
    description,
    destructive: false,
    placeholders: [DEPLOY_KEY],
  };
}
