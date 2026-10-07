import {
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

/**
 * Remediation for Railway savings findings.
 *
 * - A service's sleep schedule is `curl` against the public GraphQL API, the
 *   same mutations this plugin's stop and redeploy actions run:
 *   `deploymentStop` on the latest deployment, then `serviceInstanceRedeploy`.
 *   The CLI has no equivalent pair: `railway down` removes the deployment
 *   rather than stopping it, and `railway redeploy` then refuses a removed
 *   deployment.
 * - An unmounted volume (the orphan) is deleted with the CLI:
 *   `railway volume --project P --environment E delete --volume V --yes`.
 *
 * References (verified 2026-10):
 * https://docs.railway.com/integrations/api/manage-deployments
 * https://docs.railway.com/integrations/api/manage-services
 * https://github.com/railwayapp/cli/blob/master/src/commands/volume.rs
 * https://github.com/railwayapp/cli/blob/master/src/commands/down.rs
 * https://github.com/railwayapp/cli/blob/master/src/commands/redeploy.rs
 */
export function railwayRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  const { kind } = finding;
  if (kind !== "orphan" && kind !== "sleep-schedule") return [];
  const { resource } = finding;
  const [idEnv = "", idName = ""] = (resource.externalId ?? "").split("/");
  const environmentId = remediationField(resource, "environmentId") || idEnv;

  if (kind === "sleep-schedule" && resource.resourceTypeId === "service") {
    const serviceId = remediationField(resource, "serviceId") || idName;
    const deploymentId = remediationField(resource, "latestDeploymentId");
    if (!environmentId || !serviceId || !deploymentId) return [];
    return [
      graphql(
        "mutation($id: String!) { deploymentStop(id: $id) }",
        { id: deploymentId },
        "Stop the service's latest deployment (as of the last sync); it stops billing for compute.",
      ),
      graphql(
        "mutation($serviceId: String!, $environmentId: String!) { serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId) }",
        { serviceId, environmentId },
        "Redeploy the service from its latest deployment.",
      ),
    ];
  }

  if (kind === "orphan" && resource.resourceTypeId === "volume") {
    const projectId = remediationField(resource, "projectId");
    if (!projectId || !environmentId || !idName) return [];
    return [
      {
        tool: "railway",
        command: `railway volume --project ${shellQuote(projectId)} --environment ${shellQuote(environmentId)} delete --volume ${shellQuote(idName)} --yes`,
        description:
          "Delete the unmounted volume and all of its data; download anything you need first with `railway volume files download`.",
        destructive: true,
      },
    ];
  }

  return [];
}

const API_TOKEN: RemediationPlaceholder = {
  name: "RAILWAY_API_TOKEN",
  description: "A Railway account or workspace token with access to this project",
};

function graphql(
  query: string,
  variables: Record<string, string>,
  description: string,
): RemediationCommand {
  return {
    tool: "curl",
    command:
      `curl -sS -X POST https://backboard.railway.com/graphql/v2 -H "Authorization: Bearer $RAILWAY_API_TOKEN"` +
      ` -H 'Content-Type: application/json' -d ${shellQuote(JSON.stringify({ query, variables }))}`,
    description,
    destructive: false,
    placeholders: [API_TOKEN],
  };
}
