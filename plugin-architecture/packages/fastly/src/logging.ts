/**
 * Real-time log streaming endpoints. Fastly has no single "list all logging
 * endpoints" call: each destination type is its own collection under
 * `/service/{id}/version/{v}/logging/{type}`. The type slugs and labels are
 * the ones in Fastly's published OpenAPI clients (2026-10).
 */
export const LOGGING_TYPES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "azureblob", label: "Azure Blob Storage" },
  { id: "bigquery", label: "BigQuery" },
  { id: "cloudfiles", label: "Rackspace Cloud Files" },
  { id: "datadog", label: "Datadog" },
  { id: "digitalocean", label: "DigitalOcean Spaces" },
  { id: "elasticsearch", label: "Elasticsearch" },
  { id: "ftp", label: "FTP" },
  { id: "gcs", label: "Google Cloud Storage" },
  { id: "grafanacloudlogs", label: "Grafana Cloud Logs" },
  { id: "heroku", label: "Heroku" },
  { id: "honeycomb", label: "Honeycomb" },
  { id: "https", label: "HTTPS" },
  { id: "kafka", label: "Kafka" },
  { id: "kinesis", label: "Amazon Kinesis" },
  { id: "logentries", label: "Logentries" },
  { id: "loggly", label: "Loggly" },
  { id: "logshuttle", label: "Log Shuttle" },
  { id: "newrelic", label: "New Relic Logs" },
  { id: "newrelicotlp", label: "New Relic OTLP" },
  { id: "openstack", label: "OpenStack" },
  { id: "papertrail", label: "Papertrail" },
  { id: "pubsub", label: "Google Cloud Pub/Sub" },
  { id: "s3", label: "Amazon S3" },
  { id: "scalyr", label: "Scalyr" },
  { id: "sftp", label: "SFTP" },
  { id: "splunk", label: "Splunk" },
  { id: "sumologic", label: "Sumo Logic" },
  { id: "syslog", label: "Syslog" },
];

export function loggingTypeLabel(id: string): string {
  return LOGGING_TYPES.find((t) => t.id === id)?.label ?? id;
}

/** The fields an endpoint object may carry; every type has a different subset. */
export interface FastlyLoggingEndpoint {
  name?: string;
  format?: string;
  format_version?: string | number;
  placement?: string | null;
  response_condition?: string;
  url?: string;
  address?: string;
  hostname?: string;
  host?: string;
  port?: number | string;
  bucket_name?: string;
  path?: string;
  topic?: string;
  dataset?: string;
  table?: string;
  project_id?: string;
  region?: string;
  container?: string;
  index?: string;
  topics?: string;
  brokers?: string;
  domain?: string;
  period?: number | string;
  created_at?: string;
  updated_at?: string;
}

/**
 * The one line that says where the logs go: a URL, a bucket, a topic. Never
 * includes credentials; the API redacts most of them anyway.
 */
export function destinationOf(type: string, e: FastlyLoggingEndpoint): string {
  const s = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());
  switch (type) {
    case "s3":
    case "gcs":
    case "digitalocean":
    case "cloudfiles":
    case "openstack":
      return [s(e.bucket_name), s(e.path)].filter(Boolean).join("") || s(e.domain);
    case "azureblob":
      return [s(e.container), s(e.path)].filter(Boolean).join("");
    case "bigquery":
      return [s(e.project_id), s(e.dataset), s(e.table)].filter(Boolean).join(".");
    case "pubsub":
      return [s(e.project_id), s(e.topic)].filter(Boolean).join("/");
    case "kafka":
      return [s(e.brokers), s(e.topic)].filter(Boolean).join(" / ");
    case "kinesis":
      return [s(e.topic), s(e.region)].filter(Boolean).join(" in ");
    case "elasticsearch":
      return [s(e.url), s(e.index)].filter(Boolean).join(" / ");
    default: {
      const host = s(e.url) || s(e.address) || s(e.hostname) || s(e.host);
      const port = s(e.port);
      return host && port && !host.includes("://") ? `${host}:${port}` : host || s(e.region);
    }
  }
}
