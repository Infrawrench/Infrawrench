import type { CreateFieldConfig, CreateResourceConfig } from "@infrawrench/plugin-base";
import { paged } from "./api.js";
import type { CockroachClient } from "./client.js";
import { ROLES } from "./resource-types.js";

interface AvailableRegion {
  name: string;
  location: string;
  provider: "GCP" | "AWS" | "AZURE";
  serverless: boolean;
  distance: number;
}

async function clusterPicker(
  client: CockroachClient,
  parent: string,
): Promise<CreateFieldConfig[]> {
  if (parent) return [];
  const clusters = (await client.clusters()).filter((c) => c.state !== "DELETED");
  const options = clusters.map((c) => ({
    id: c.id,
    label: c.name,
    description: `${c.plan ?? ""} · ${c.regions[0]?.name ?? ""}`,
  }));
  return [
    {
      key: "clusterId",
      label: "Cluster",
      kind: "select",
      required: true,
      options,
      ...(options[0] ? { defaultValue: options[0].id } : {}),
    },
  ];
}

export async function getCreateConfig(
  client: CockroachClient,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  const parent = parentResourceId ? parentResourceId.split(":").slice(2).join(":") : "";
  switch (typeId) {
    case "crdb-folder": {
      const folders = await client.folders();
      return {
        fields: [
          { key: "name", label: "Folder Name", kind: "text", required: true },
          {
            key: "parentId",
            label: "Inside",
            kind: "select",
            required: false,
            options: [
              { id: "root", label: "Top level" },
              ...folders.map((f) => ({ id: f.resource_id, label: f.name })),
            ],
            defaultValue: "root",
          },
        ],
      };
    }
    case "crdb-cluster": {
      const [regions, folders] = await Promise.all([
        paged<AvailableRegion>(client.ctx, "/api/v1/clusters/available-regions", "regions"),
        client.folders().catch(() => []),
      ]);
      const advanced = { fieldKey: "plan", fieldValue: "ADVANCED" };
      return {
        fields: [
          {
            key: "name",
            label: "Cluster Name",
            kind: "text",
            required: true,
            description: "6-20 characters: lowercase letters, numbers and dashes.",
          },
          {
            key: "plan",
            label: "Plan",
            kind: "select",
            required: true,
            options: [
              { id: "BASIC", label: "Basic (pay per use, scales to zero)" },
              { id: "STANDARD", label: "Standard (provisioned vCPUs, multi-tenant)" },
              { id: "ADVANCED", label: "Advanced (dedicated nodes)" },
            ],
            defaultValue: "BASIC",
          },
          {
            key: "provider",
            label: "Cloud",
            kind: "select",
            required: true,
            options: [
              { id: "AWS", label: "AWS" },
              { id: "GCP", label: "Google Cloud" },
              { id: "AZURE", label: "Azure" },
            ],
            defaultValue: "AWS",
          },
          {
            key: "regions",
            label: "Regions",
            kind: "policy-picker",
            required: true,
            description:
              "The first region is the primary for multi-region Basic/Standard clusters.",
            policies: regions.map((r) => ({
              id: r.name,
              label: `${r.name} (${r.location})`,
              category: r.provider,
              ...(r.serverless ? {} : { badge: "Advanced" }),
            })),
          },
          {
            key: "provisionedVcpus",
            label: "Provisioned vCPUs",
            kind: "number",
            required: false,
            minValue: 2,
            defaultValue: "2",
            showWhen: { fieldKey: "plan", fieldValue: "STANDARD" },
          },
          {
            key: "vcpus",
            label: "vCPUs per Node",
            kind: "select",
            required: false,
            options: ["2", "4", "8", "16", "32"].map((v) => ({ id: v, label: `${v} vCPUs` })),
            defaultValue: "4",
            showWhen: advanced,
          },
          {
            key: "nodeCount",
            label: "Nodes per Region",
            kind: "number",
            required: false,
            minValue: 1,
            defaultValue: "3",
            showWhen: advanced,
          },
          {
            key: "storageGib",
            label: "Storage per Node (GiB)",
            kind: "number",
            required: false,
            description: "Empty picks the smallest size for the machine.",
            showWhen: advanced,
          },
          {
            key: "closedAllowlist",
            label: "Network Access",
            kind: "select",
            required: false,
            options: [
              { id: "true", label: "Closed: add allowlist entries later" },
              { id: "false", label: "Open to any address" },
            ],
            defaultValue: "true",
            showWhen: { fieldKey: "plan", fieldValues: ["BASIC", "STANDARD"] },
          },
          {
            key: "folderId",
            label: "Folder",
            kind: "select",
            required: false,
            options: [
              { id: "", label: "Top level" },
              ...folders.map((f) => ({ id: f.resource_id, label: f.name })),
            ],
            defaultValue: "",
          },
          {
            key: "deleteProtection",
            label: "Delete Protection",
            kind: "select",
            required: false,
            options: [
              { id: "true", label: "On" },
              { id: "false", label: "Off" },
            ],
            defaultValue: "true",
          },
        ],
      };
    }
    case "crdb-database":
      return {
        fields: [
          ...(await clusterPicker(client, parent)),
          { key: "name", label: "Database Name", kind: "text", required: true },
        ],
      };
    case "crdb-sql-user":
      return {
        fields: [
          ...(await clusterPicker(client, parent)),
          { key: "name", label: "Username", kind: "text", required: true },
          {
            key: "password",
            label: "Password",
            kind: "password",
            required: false,
            description:
              "Leave blank to generate one. It is stored encrypted for the connection string output.",
          },
        ],
      };
    case "crdb-allowlist-entry":
      return {
        fields: [
          ...(await clusterPicker(client, parent)),
          {
            key: "cidr",
            label: "IPv4 CIDR",
            kind: "text",
            required: true,
            placeholder: "203.0.113.0/24",
          },
          { key: "name", label: "Name", kind: "text", required: false },
          {
            key: "sql",
            label: "SQL Access",
            kind: "select",
            required: true,
            options: [
              { id: "true", label: "Yes" },
              { id: "false", label: "No" },
            ],
            defaultValue: "true",
          },
          {
            key: "ui",
            label: "DB Console Access",
            kind: "select",
            required: true,
            options: [
              { id: "false", label: "No" },
              { id: "true", label: "Yes" },
            ],
            defaultValue: "false",
          },
        ],
      };
    case "crdb-log-export": {
      const show = (...t: string[]) => ({ fieldKey: "type", fieldValues: t });
      return {
        fields: [
          ...(await clusterPicker(client, parent)),
          {
            key: "type",
            label: "Destination",
            kind: "select",
            required: true,
            options: [
              { id: "AWS_CLOUDWATCH", label: "AWS CloudWatch" },
              { id: "GCP_CLOUD_LOGGING", label: "Google Cloud Logging" },
              { id: "OTLP_HTTP", label: "OpenTelemetry (OTLP/HTTP)" },
            ],
            defaultValue: "AWS_CLOUDWATCH",
          },
          {
            key: "logName",
            label: "Log Name",
            kind: "text",
            required: true,
            defaultValue: "cockroachdb",
          },
          {
            key: "authPrincipal",
            label: "IAM Role ARN or GCP Project ID",
            kind: "text",
            required: false,
            description:
              "CloudWatch: the role CockroachDB Cloud assumes. Cloud Logging: the destination project ID.",
            showWhen: show("AWS_CLOUDWATCH", "GCP_CLOUD_LOGGING"),
          },
          {
            key: "otlpEndpoint",
            label: "OTLP Endpoint",
            kind: "text",
            required: false,
            showWhen: show("OTLP_HTTP"),
          },
          {
            key: "otlpAuthorization",
            label: "Authorization Header",
            kind: "password",
            required: false,
            showWhen: show("OTLP_HTTP"),
          },
          {
            key: "region",
            label: "Destination Region",
            kind: "text",
            required: false,
            description: "Optional override.",
          },
          {
            key: "redact",
            label: "Redact Sensitive Data",
            kind: "select",
            required: false,
            options: [
              { id: "false", label: "No" },
              { id: "true", label: "Yes" },
            ],
            defaultValue: "false",
          },
        ],
      };
    }
    case "crdb-metric-export": {
      const show = (k: string) => ({ fieldKey: "kind", fieldValue: k });
      return {
        fields: [
          ...(await clusterPicker(client, parent)),
          {
            key: "kind",
            label: "Destination",
            kind: "select",
            required: true,
            options: [
              { id: "datadog", label: "Datadog" },
              { id: "cloudwatch", label: "AWS CloudWatch" },
              { id: "prometheus", label: "Prometheus scrape endpoint" },
            ],
            defaultValue: "datadog",
          },
          {
            key: "datadogApiKey",
            label: "Datadog API Key",
            kind: "password",
            required: false,
            showWhen: show("datadog"),
          },
          {
            key: "datadogSite",
            label: "Datadog Site",
            kind: "select",
            required: false,
            options: ["US1", "US3", "US5", "US1_GOV", "EU1"].map((s) => ({ id: s, label: s })),
            defaultValue: "US1",
            showWhen: show("datadog"),
          },
          {
            key: "roleArn",
            label: "IAM Role ARN",
            kind: "text",
            required: false,
            showWhen: show("cloudwatch"),
          },
          {
            key: "targetRegion",
            label: "AWS Region",
            kind: "text",
            required: false,
            showWhen: show("cloudwatch"),
          },
          {
            key: "logGroupName",
            label: "Log Group",
            kind: "text",
            required: false,
            showWhen: show("cloudwatch"),
          },
        ],
      };
    }
    case "crdb-blackout-window":
      return {
        fields: [
          ...(await clusterPicker(client, parent)),
          {
            key: "startTime",
            label: "Starts",
            kind: "datetime",
            required: true,
            description: "At least 7 days from now.",
          },
          {
            key: "endTime",
            label: "Ends",
            kind: "datetime",
            required: true,
            description: "Up to 14 days after the start.",
          },
        ],
      };
    case "crdb-egress-rule":
      return {
        fields: [
          ...(await clusterPicker(client, parent)),
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "type",
            label: "Type",
            kind: "select",
            required: true,
            options: [
              { id: "FQDN", label: "Domain name" },
              { id: "CIDR", label: "IP range" },
            ],
            defaultValue: "FQDN",
          },
          {
            key: "destination",
            label: "Destination",
            kind: "text",
            required: true,
            placeholder: "api.example.com",
          },
          {
            key: "ports",
            label: "Ports",
            kind: "string-list",
            required: false,
            addLabel: "Add port",
          },
          { key: "description", label: "Description", kind: "text", required: false },
        ],
      };
    case "crdb-service-account":
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "description", label: "Description", kind: "text", required: false },
          {
            key: "roles",
            label: "Organization Roles",
            kind: "policy-picker",
            required: false,
            policies: ROLES.map((r) => ({ id: r, label: r.replace(/_/g, " ").toLowerCase() })),
          },
        ],
      };
    case "crdb-api-key": {
      const sas = parent ? [] : await client.serviceAccounts();
      return {
        fields: [
          ...(parent
            ? []
            : [
                {
                  key: "serviceAccountId",
                  label: "Service Account",
                  kind: "select" as const,
                  required: true,
                  options: sas.map((s) => ({ id: s.id, label: s.name })),
                  ...(sas[0] ? { defaultValue: sas[0].id } : {}),
                },
              ]),
          { key: "name", label: "Key Name", kind: "text", required: true },
        ],
      };
    }
    default:
      throw new Error(`CockroachDB Cloud plugin: no create form for "${typeId}".`);
  }
}
