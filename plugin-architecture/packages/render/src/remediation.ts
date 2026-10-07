import {
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

/**
 * Remediation for Render savings findings.
 *
 * - Postgres and Key Value sleep schedules use the Render CLI
 *   (`render pg|kv suspend --confirm`, `render pg|kv resume`); without
 *   `--confirm` suspend only previews.
 * - The CLI has no suspend or resume for services, so a service's sleep
 *   schedule is `curl` against the REST API the plugin's own actions call.
 * - A service suspended by a user (the orphan) is deleted with
 *   `render services delete --confirm`, which also removes any attached disk.
 *
 * References (verified 2026-10):
 * https://render.com/docs/cli-reference
 * https://api-docs.render.com (POST /v1/services/{serviceId}/suspend, /resume)
 */
export function renderRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan" && finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  const id = remediationId(resource);
  if (!id || id.includes("/")) return [];

  if (resource.resourceTypeId === "service") {
    if (finding.kind === "orphan") {
      return [
        {
          tool: "render",
          command: `render services delete ${shellQuote(id)} --confirm`,
          description:
            "Delete the suspended service, together with any disk attached to it; this cannot be undone.",
          destructive: true,
        },
      ];
    }
    const base = `${API}/services/${encodeURIComponent(id)}`;
    return [
      curl(`${base}/suspend`, "Suspend the service; its instances stop billing."),
      curl(`${base}/resume`, "Resume the service from its last deploy."),
    ];
  }

  if (finding.kind !== "sleep-schedule") return [];
  const group =
    resource.resourceTypeId === "postgres"
      ? "pg"
      : resource.resourceTypeId === "key-value"
        ? "kv"
        : "";
  if (!group) return [];
  const what = group === "pg" ? "database" : "instance";
  return [
    {
      tool: "render",
      command: `render ${group} suspend ${shellQuote(id)} --confirm`,
      description: `Suspend the ${what}; compute stops billing until it is resumed.`,
      destructive: false,
    },
    {
      tool: "render",
      command: `render ${group} resume ${shellQuote(id)}`,
      description: `Resume the ${what}.`,
      destructive: false,
    },
  ];
}

const API = "https://api.render.com/v1";

const API_KEY: RemediationPlaceholder = {
  name: "RENDER_API_KEY",
  description: "A Render API key with access to this workspace",
};

/** A POST with no body. The id is percent-encoded, so nothing in the URL is shell syntax. */
function curl(url: string, description: string): RemediationCommand {
  return {
    tool: "curl",
    command: `curl -sS -X POST ${shellQuote(url)} -H "Authorization: Bearer $RENDER_API_KEY"`,
    description,
    destructive: false,
    placeholders: [API_KEY],
  };
}
