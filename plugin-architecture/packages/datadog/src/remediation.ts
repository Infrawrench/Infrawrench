/**
 * Remediation commands for Datadog savings findings: today, the unused custom
 * metric rule in `idle-findings.ts`. Datadog has no official CLI for metric
 * configuration, so these are `curl` calls against the documented endpoints
 * (https://docs.datadoghq.com/api/latest/metrics/, verified 2026-10), with the
 * keys read from the environment.
 *
 * Both are reads. A custom metric cannot be deleted through the API: it stops
 * billing when whatever submits it stops (an agent check, a library call in
 * the customer's own code), or it can be narrowed in Metrics Summary with
 * Metrics without Limits. Neither is something a pasted command can do
 * safely, so the commands confirm the finding (what uses the metric, how many
 * series it indexes) and the description names the fix.
 */
import {
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

const DD_API_KEY: RemediationPlaceholder = {
  name: "DD_API_KEY",
  description: "A Datadog API key for this organization",
};
const DD_APP_KEY: RemediationPlaceholder = {
  name: "DD_APP_KEY",
  description: "A Datadog application key with the metrics_read scope",
};

const HEADERS = `-H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY"`;

function metricUrl(apiUrl: string, metric: string, suffix: string): string {
  return shellQuote(`${apiUrl}/api/v2/metrics/${encodeURIComponent(metric)}/${suffix}`);
}

export function datadogRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan" || finding.idleRuleId !== "unused-custom-metric") return [];
  const metric = finding.resource.externalId ?? "";
  const apiUrl = remediationField(finding.resource, "apiUrl");
  if (!metric || !apiUrl.startsWith("https://")) return [];
  return [
    {
      tool: "curl",
      command: `curl -sS ${metricUrl(apiUrl, metric, "assets")} ${HEADERS}`,
      description:
        "Lists the dashboards, monitors, notebooks and SLOs that use the metric; an empty list confirms the finding.",
      destructive: false,
      placeholders: [DD_API_KEY, DD_APP_KEY],
    },
    {
      tool: "curl",
      command: `curl -sS ${metricUrl(apiUrl, metric, "volumes")} ${HEADERS}`,
      description:
        "Shows how many series it indexes and ingests. Stop submitting it where it is emitted, or narrow its tags in Metrics Summary (Metrics without Limits), to stop the charge.",
      destructive: false,
      placeholders: [DD_API_KEY, DD_APP_KEY],
    },
  ];
}
