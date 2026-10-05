/**
 * Datadog bills per *product* (`product_name` in the cost endpoints:
 * `infra_host`, `apm_host`, `logs_indexed_15day`, …). Those identifiers are
 * what lands in the generic `service` dimension, so the label has to be a pure
 * function of the identifier: `service` is part of the key the host dedupes
 * restatement re-fetches on, and a label that depended on anything else (a
 * second API call, a lookup that failed on one run) would file the same money
 * under two names.
 *
 * Known products get Datadog's own wording; everything else is title-cased
 * with the acronyms Datadog writes in capitals kept in capitals. A product
 * Datadog launches tomorrow therefore still reads sensibly rather than
 * falling through as a raw snake_case id.
 */
const KNOWN: Record<string, string> = {
  infra_host: "Infrastructure Hosts",
  infra_container: "Containers",
  infra_container_excl_agent: "Containers",
  apm_host: "APM Hosts",
  apm_host_enterprise: "APM Enterprise Hosts",
  apm_fargate: "APM Fargate Tasks",
  apm_trace_search: "Indexed Spans",
  ingested_spans: "Ingested Spans",
  indexed_spans: "Indexed Spans",
  logs_ingested: "Log Ingestion",
  ingested_logs: "Log Ingestion",
  logs_indexed: "Indexed Logs",
  custom_event: "Custom Events",
  timeseries: "Custom Metrics",
  custom_metrics: "Custom Metrics",
  synthetics_api_tests: "Synthetics API Tests",
  synthetics_browser_checks: "Synthetics Browser Tests",
  synthetics_mobile: "Synthetics Mobile Tests",
  rum: "RUM Sessions",
  rum_browser_sessions: "RUM Browser Sessions",
  rum_mobile_sessions: "RUM Mobile Sessions",
  rum_replay: "RUM Session Replay",
  serverless_apm: "Serverless APM",
  serverless_infra: "Serverless Functions",
  serverless_apps: "Serverless Apps",
  fargate_container: "Fargate Tasks",
  npm_host: "Cloud Network Monitoring Hosts",
  network_hosts: "Cloud Network Monitoring Hosts",
  network_flows: "Network Flows",
  network_device: "Network Devices",
  snmp: "Network Devices",
  dbm_host: "Database Monitoring Hosts",
  dbm_queries: "Database Monitoring Queries",
  profiling_host: "Continuous Profiler Hosts",
  profiled_host: "Continuous Profiler Hosts",
  profiled_container: "Continuous Profiler Containers",
  siem: "Cloud SIEM",
  cspm_host: "CSM Hosts",
  cws_host: "Workload Protection Hosts",
  ci_pipeline: "CI Visibility Pipelines",
  ci_testing: "Test Optimization",
  incident_management: "Incident Management",
  observability_pipeline: "Observability Pipelines",
  online_archive: "Online Archives",
  sensitive_data_scanner: "Sensitive Data Scanner",
  audit_trail: "Audit Trail",
  error_tracking: "Error Tracking",
  llm_observability: "LLM Observability",
  iot: "IoT Devices",
  cloud_cost_management: "Cloud Cost Management",
  application_security_host: "App and API Protection Hosts",
  workflow_executions: "Workflow Automation",
};

const UPPER = new Set([
  "apm",
  "rum",
  "ci",
  "cd",
  "csm",
  "cspm",
  "cws",
  "dbm",
  "siem",
  "llm",
  "npm",
  "ndm",
  "api",
  "iot",
  "aws",
  "gcp",
  "sds",
  "snmp",
  "ai",
  "oci",
  "asm",
]);

export function productLabel(product: string): string {
  const id = product.trim();
  if (!id) return "Other";
  const known = KNOWN[id];
  if (known) return known;
  return id
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (UPPER.has(lower)) return lower.toUpperCase();
      if (/^\d+day$/.test(lower)) return `${lower.slice(0, -3)}-Day`;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}
