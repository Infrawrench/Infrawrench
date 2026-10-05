import {
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

/**
 * Remediation for Baseten savings findings: `curl` against the management API,
 * the same routes this plugin's own actions call. Deployments and environments
 * are addressed by `<modelId>/<id>` external ids (see `resource-types.ts`).
 *
 * - An idle deployment (warm min replicas, no requests in 7 days) is best
 *   scaled to zero, which keeps it callable; deactivating is the stronger fix.
 * - A sleep schedule deactivates and re-activates the deployment or environment.
 *
 * References:
 * https://docs.baseten.co/reference/management-api/deployments/deactivate/deactivates-a-deployment
 * https://docs.baseten.co/reference/management-api/deployments/activate/activates-a-deployment
 * https://docs.baseten.co/reference/management-api/deployments/autoscaling/updates-a-deployments-autoscaling-settings
 */
export function basetenRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan" && finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  const [idScope = "", idName = ""] = (resource.externalId ?? "").split("/");
  const modelId = remediationField(resource, "modelId") || idScope;
  if (!modelId) return [];

  if (resource.resourceTypeId === "deployment") {
    if (!idName) return [];
    const base = `${API}/models/${encodeURIComponent(modelId)}/deployments/${encodeURIComponent(idName)}`;
    if (finding.kind === "orphan") {
      return [
        request(
          "PATCH",
          `${base}/autoscaling_settings`,
          "Lower min replicas to 0 so the deployment scales to zero between requests.",
          { min_replica: 0 },
        ),
        request(
          "POST",
          `${base}/deactivate`,
          "Or deactivate it: it stops billing until activated.",
        ),
      ];
    }
    return [
      request(
        "POST",
        `${base}/deactivate`,
        "Deactivate the deployment; its replicas stop billing.",
      ),
      request("POST", `${base}/activate`, "Activate it again."),
    ];
  }

  if (resource.resourceTypeId === "environment" && finding.kind === "sleep-schedule") {
    const name = remediationField(resource, "name") || idName;
    if (!name) return [];
    const base = `${API}/models/${encodeURIComponent(modelId)}/environments/${encodeURIComponent(name)}`;
    return [
      request("POST", `${base}/deactivate`, "Deactivate the environment's current deployment."),
      request("POST", `${base}/activate`, "Activate it again."),
    ];
  }

  return [];
}

const API = "https://api.baseten.co/v1";

const PLACEHOLDERS: RemediationPlaceholder[] = [
  { name: "BASETEN_API_KEY", description: "A Baseten API key for this workspace" },
];

/** One API call. Ids in the URL are percent-encoded, so nothing there is shell syntax. */
function request(
  method: "POST" | "PATCH",
  url: string,
  description: string,
  body?: Record<string, unknown>,
): RemediationCommand {
  return {
    tool: "curl",
    command:
      `curl -sS -X ${method} ${shellQuote(url)} -H "Authorization: Api-Key $BASETEN_API_KEY"` +
      (body ? ` -H 'Content-Type: application/json' -d ${shellQuote(JSON.stringify(body))}` : ""),
    description,
    destructive: false,
    placeholders: PLACEHOLDERS,
  };
}
