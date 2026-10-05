import {
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

/**
 * Remediation for ClickHouse Cloud savings findings: `curl` against the Cloud
 * API (Basic auth with an API key id and secret). The organization id is an
 * account credential rather than a synced field, so it is a placeholder too.
 *
 * References:
 * https://clickhouse.com/docs/products/cloud/api-reference/service/update-service-state
 * https://clickhouse.com/docs/products/cloud/api-reference/clickpipes/update-clickpipe-state
 */
export function clickhouseRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;

  if (resource.resourceTypeId === "ch-service") {
    const service = remediationId(resource, "serviceId");
    if (!service) return [];
    const url = `${ORG_BASE}/services/${encodeURIComponent(service)}/state`;
    return [
      stateCommand(
        url,
        "stop",
        "Stop the service; compute stops billing while storage and backups keep billing.",
      ),
      stateCommand(url, "start", "Start the service again."),
    ];
  }

  if (resource.resourceTypeId === "ch-clickpipe") {
    // externalId is `<serviceId>/<clickPipeId>`; the fields carry both too.
    const [idService = "", idPipe = ""] = (resource.externalId ?? "").split("/");
    const service = remediationField(resource, "serviceId") || idService;
    const pipe = remediationField(resource, "clickPipeId") || idPipe;
    if (!service || !pipe) return [];
    const url = `${ORG_BASE}/services/${encodeURIComponent(service)}/clickpipes/${encodeURIComponent(pipe)}/state`;
    return [
      stateCommand(url, "stop", "Stop the ClickPipe so it stops ingesting and billing compute."),
      stateCommand(url, "start", "Start the ClickPipe again."),
    ];
  }

  return [];
}

const ORG_BASE = "https://api.clickhouse.cloud/v1/organizations/$CLICKHOUSE_ORG_ID";

const PLACEHOLDERS: RemediationPlaceholder[] = [
  { name: "CLICKHOUSE_ORG_ID", description: "The ClickHouse Cloud organization id" },
  { name: "CLICKHOUSE_KEY_ID", description: "A ClickHouse Cloud API key id" },
  { name: "CLICKHOUSE_KEY_SECRET", description: "The secret for that API key" },
];

/**
 * One state PATCH. The URL goes in double quotes so `$CLICKHOUSE_ORG_ID`
 * expands; the ids in it are percent-encoded, so nothing else in it is shell
 * syntax.
 */
function stateCommand(
  url: string,
  command: "start" | "stop",
  description: string,
): RemediationCommand {
  return {
    tool: "curl",
    command: `curl -sS -X PATCH "${url}" -u "$CLICKHOUSE_KEY_ID:$CLICKHOUSE_KEY_SECRET" -H 'Content-Type: application/json' -d ${shellQuote(JSON.stringify({ command }))}`,
    description,
    destructive: false,
    placeholders: PLACEHOLDERS,
  };
}
