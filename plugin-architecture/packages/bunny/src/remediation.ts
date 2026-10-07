import {
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

/**
 * Remediation for bunny.net savings findings: `curl` against the Magic
 * Containers API (the same routes this plugin's deploy/undeploy actions call),
 * authenticated with the account API key in the `AccessKey` header.
 *
 * - A Magic Containers app on a sleep schedule: undeploy (stops every running
 *   instance), then deploy again.
 *
 * References:
 * https://docs.bunny.net/api-reference/magic-containers/applications/undeploy-application
 * https://docs.bunny.net/api-reference/magic-containers/applications/deploy-application
 */
export function bunnyRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "sleep-schedule" || finding.resource.resourceTypeId !== "container-app") {
    return [];
  }
  const id = (finding.resource.externalId ?? "").trim();
  if (!id) return [];
  const base = `https://api.bunny.net/mc/apps/${encodeURIComponent(id)}`;
  return [
    request(`${base}/undeploy`, "Undeploy the app; all running instances stop."),
    request(`${base}/deploy`, "Deploy the app again."),
  ];
}

const PLACEHOLDERS: RemediationPlaceholder[] = [
  { name: "BUNNY_API_KEY", description: "The bunny.net account API key" },
];

function request(url: string, description: string): RemediationCommand {
  return {
    tool: "curl",
    command: `curl -sS -X POST ${shellQuote(url)} -H "AccessKey: $BUNNY_API_KEY"`,
    description,
    destructive: false,
    placeholders: PLACEHOLDERS,
  };
}
