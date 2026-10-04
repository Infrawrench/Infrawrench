import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { formatBytes, joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { CONSOLE_URL } from "./api.js";
import { DEFAULT_METRICS_WINDOW_MS } from "./metrics.js";
import {
  CREATE_KAFKA_KEY_COMMAND,
  RESOURCE_TYPES,
  createKafkaKeyAction,
} from "./resource-types.js";

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function kv(items: Array<[string, unknown, boolean?]>): SchemaNode {
  const list: KVItem[] = [];
  for (const [key, value, copyable] of items) {
    const text = typeof value === "boolean" ? (value ? "Yes" : "No") : str(value);
    if (text === "") continue;
    list.push({ key, value: text, ...(copyable ? { copyable: true } : {}) });
  }
  return { kind: "key-value-list", items: list };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function note(content: string): SchemaNode {
  return { kind: "text", variant: "muted", content };
}

function openUrl(label: string, url: string): ActionNode {
  return { kind: "action", label, action: { type: "open-url", url } };
}

function bytes(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  return v === undefined || v === "" || !Number.isFinite(n) ? "" : formatBytes(n);
}

function count(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  return v === undefined || v === "" || !Number.isFinite(n) ? "" : n.toLocaleString("en-US");
}

/** Provisioning phases share one vocabulary across the management APIs. */
export function phaseStatus(phase: string): ResourceStatus {
  switch (phase.toUpperCase()) {
    case "PROVISIONED":
    case "READY":
    case "RUNNING":
      return "healthy";
    case "PROVISIONING":
    case "DEPROVISIONING":
    case "PENDING":
    case "PENDING_ACCEPT":
      return "provisioning";
    case "FAILED":
      return "error";
    case "":
      return "info";
    default:
      return "degraded";
  }
}

export function connectorStatus(state: string): ResourceStatus {
  switch (state) {
    case "RUNNING":
      return "healthy";
    case "PROVISIONING":
      return "provisioning";
    case "DEGRADED":
      return "degraded";
    case "FAILED":
      return "error";
    case "PAUSED":
      return "unknown";
    default:
      return "info";
  }
}

const envUrl = (env: string) => `${CONSOLE_URL}/environments/${encodeURIComponent(env)}/clusters`;
const clusterUrl = (env: string, cluster: string) =>
  `${CONSOLE_URL}/environments/${encodeURIComponent(env)}/clusters/${encodeURIComponent(cluster)}/overview`;

/** CKU choices for a Dedicated cluster: multi-zone needs at least two. */
export function ckuOptions(availability: string, current: number): number[] {
  const min = availability.toUpperCase().includes("MULTI") ? 2 : 1;
  const max = Math.max(24, current + 4);
  const out: number[] = [];
  for (let n = min; n <= max; n++) out.push(n);
  return out;
}

function resizeAction(r: ResourceInstance): ActionNode | null {
  const f = r.fields;
  const type = str(f["clusterType"]);
  if (type === "Dedicated") {
    const current = Number(f["cku"] ?? 0);
    const field: CreateFieldConfig = {
      key: "cku",
      label: "CKUs",
      kind: "select",
      required: true,
      defaultValue: current ? String(current) : "",
      options: ckuOptions(str(f["availability"]), current).map((n) => ({
        id: String(n),
        label:
          n === current
            ? `${n} CKU${n === 1 ? "" : "s"} (current)`
            : `${n} CKU${n === 1 ? "" : "s"}`,
      })),
      description:
        "Billing follows the new size from the next hour. Expanding takes a while on large clusters, and Confluent refuses a shrink the cluster's current load or partition count cannot fit into.",
    };
    return {
      kind: "action",
      label: "Resize",
      action: {
        type: "prompt-nosql-command",
        command: "resize",
        title: "Resize Dedicated cluster",
        fields: [field],
        submitLabel: "Resize",
      },
    };
  }
  if (type) {
    const current = Number(f["maxEcku"] ?? 0);
    return {
      kind: "action",
      label: "Change eCKU limit",
      action: {
        type: "prompt-nosql-command",
        command: "resize",
        title: "Change the eCKU ceiling",
        description:
          "The cluster scales automatically up to this many eCKUs and is billed only for what it uses each hour. A lower ceiling caps cost and throughput.",
        fields: [
          {
            key: "maxEcku",
            label: "Max eCKUs",
            kind: "select",
            required: true,
            defaultValue: current ? String(current) : "",
            options: Array.from({ length: Math.max(32, current) }, (_, i) => i + 1).map((n) => ({
              id: String(n),
              label: n === current ? `${n} (current)` : String(n),
            })),
          },
        ],
        submitLabel: "Save",
      },
    };
  }
  return null;
}

function renderEnvironment(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const env = str(f["environmentId"]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Environment", env),
    status: { kind: "status-dot", status: "healthy", label: "Environment" },
    sections: [
      section("Environment", [
        kv([
          ["Name", f["name"]],
          ["Environment ID", env, true],
          ["Stream Governance", f["streamGovernance"]],
          ["Created", f["createdAt"]],
        ]),
      ]),
    ],
    headerActions: env ? [openUrl("Open in Confluent Cloud", envUrl(env))] : [],
  };
}

function renderCluster(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const env = str(f["environmentId"]);
  const id = str(f["clusterId"] || r.externalId);
  const type = str(f["clusterType"]);
  const phase = str(f["phase"]);
  const resize = resizeAction(r);
  const capacity: Array<[string, unknown, boolean?]> =
    type === "Dedicated" ? [["CKUs", f["cku"]]] : [["Max eCKUs", f["maxEcku"]]];
  return {
    title: r.displayName,
    subtitle: joinSubtitle(type ? `${type} cluster` : "Kafka cluster", f["cloud"], f["region"]),
    status: { kind: "status-dot", status: phaseStatus(phase), label: phase || "Cluster" },
    sections: [
      section("Cluster", [
        kv([
          ["Cluster ID", id, true],
          ["Type", type],
          ...capacity,
          ["Availability", f["availability"]],
          ["Cloud", f["cloud"]],
          ["Region", f["region"]],
          ["Environment", f["environmentName"] || env],
          ["Network", f["networkId"]],
          ["Deletion protection", f["deletionProtection"]],
          ["Created", f["createdAt"]],
        ]),
      ]),
      section("Endpoints", [
        kv([
          ["Bootstrap", str(f["bootstrapEndpoint"]).replace(/^[A-Z_]+:\/\//, ""), true],
          ["REST", f["restEndpoint"], true],
        ]),
      ]),
      section("Usage", [
        kv([
          ["Topics", count(f["topics"])],
          ["Partitions", count(f["partitions"])],
          ["Retained", bytes(f["retainedBytes"])],
          ["Produced (7 days)", bytes(f["bytesIn7d"])],
          ["Consumed (7 days)", bytes(f["bytesOut7d"])],
        ]),
        ...(f["bytesIn7d"] === undefined
          ? [
              note(
                "Usage comes from the Metrics API, which needs the MetricsViewer role on the Cloud API key's owner.",
              ),
            ]
          : []),
      ]),
    ],
    headerActions: [
      ...(resize ? [resize] : []),
      {
        kind: "action",
        label: "Create Kafka API key",
        action: {
          type: "prompt-nosql-command",
          command: CREATE_KAFKA_KEY_COMMAND,
          title: createKafkaKeyAction.title ?? createKafkaKeyAction.label,
          ...(createKafkaKeyAction.description
            ? { description: createKafkaKeyAction.description }
            : {}),
          fields: createKafkaKeyAction.fields,
          submitLabel: createKafkaKeyAction.submitLabel ?? "Create key",
        },
      },
      ...(env && id ? [openUrl("Open in Confluent Cloud", clusterUrl(env, id))] : []),
    ],
  };
}

function renderConnector(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const state = str(f["state"]);
  const env = str(f["environmentId"]);
  const cluster = str(f["clusterId"]);
  const actions: ActionNode[] = [];
  if (state === "PAUSED") {
    actions.push({
      kind: "action",
      label: "Resume",
      action: { type: "plugin-action", actionId: "resume", successMessage: "Connector resumed." },
    });
  } else if (state && state !== "PROVISIONING") {
    actions.push({
      kind: "action",
      label: "Pause",
      action: {
        type: "plugin-action",
        actionId: "pause",
        confirmMessage:
          "Pause this connector? It stops moving data until resumed, but its task hours keep billing.",
        successMessage: "Connector paused.",
      },
    });
  }
  actions.push({
    kind: "action",
    label: "Restart",
    action: {
      type: "plugin-action",
      actionId: "restart",
      confirmMessage: "Restart this connector and its tasks? Processing stops until they are back.",
      successMessage: "Connector restart requested.",
    },
  });
  if (env && cluster) actions.push(openUrl("Open in Confluent Cloud", clusterUrl(env, cluster)));
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Connector", f["connectorClass"], f["connectorType"]),
    status: { kind: "status-dot", status: connectorStatus(state), label: state || "Connector" },
    sections: [
      section("Connector", [
        kv([
          ["Connector ID", f["connectorId"], true],
          ["Connector", f["connectorClass"]],
          ["Type", f["connectorType"]],
          ["State", state],
          ["Tasks", f["tasks"]],
          ["Failed tasks", f["failedTasks"]],
          ["Max tasks", f["tasksMax"]],
          ["Kafka cluster", cluster],
          ["Environment", env],
        ]),
      ]),
      section("Last 7 days", [
        kv([
          ["Records in", count(f["recordsIn7d"])],
          ["Records out", count(f["recordsOut7d"])],
        ]),
      ]),
      ...(f["trace"]
        ? [
            section("Last error", [
              { kind: "text" as const, variant: "mono" as const, content: str(f["trace"]) },
            ]),
          ]
        : []),
    ],
    headerActions: actions,
  };
}

function simpleDetail(
  r: ResourceInstance,
  kindLabel: string,
  rows: Array<[string, unknown, boolean?]>,
  extra: SchemaNode[] = [],
): DetailViewSchema {
  const phase = str(r.fields["phase"] ?? r.fields["state"]);
  const env = str(r.fields["environmentId"]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle(kindLabel, r.fields["cloud"], r.fields["region"]),
    status: {
      kind: "status-dot",
      status: phase ? phaseStatus(phase) : "info",
      label: phase || kindLabel,
    },
    sections: [section(kindLabel, [kv(rows), ...extra])],
    headerActions: env ? [openUrl("Open in Confluent Cloud", envUrl(env))] : [],
  };
}

export function renderConfluentDetail(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  let schema: DetailViewSchema;
  switch (r.resourceTypeId) {
    case "environment":
      schema = renderEnvironment(r);
      break;
    case "kafka-cluster":
      schema = renderCluster(r);
      break;
    case "connector":
      schema = renderConnector(r);
      break;
    case "flink-compute-pool":
      schema = simpleDetail(r, "Flink compute pool", [
        ["Compute pool ID", f["poolId"], true],
        ["Max CFUs", f["maxCfu"]],
        ["Current CFUs", f["currentCfu"]],
        ["Cloud", f["cloud"]],
        ["Region", f["region"]],
        ["Default pool", f["defaultPool"]],
        ["Environment", f["environmentId"]],
        ["Created", f["createdAt"]],
      ]);
      break;
    case "ksqldb-cluster":
      schema = simpleDetail(r, "ksqlDB cluster", [
        ["ksqlDB cluster ID", f["ksqlId"], true],
        ["CSUs", f["csu"]],
        ["Paused", f["paused"]],
        ["Kafka cluster", f["kafkaClusterId"]],
        ["Endpoint", f["endpoint"], true],
        ["Storage (GB)", f["storageGb"]],
        ["Topic prefix", f["topicPrefix"]],
        ["Environment", f["environmentId"]],
        ["Created", f["createdAt"]],
      ]);
      break;
    case "schema-registry":
      schema = simpleDetail(r, "Schema Registry", [
        ["Schema Registry ID", f["registryId"], true],
        ["Package", f["package"]],
        ["Endpoint", f["endpoint"], true],
        ["Private endpoint", f["privateEndpoint"], true],
        ["Environment", f["environmentId"]],
      ]);
      break;
    case "service-account":
      schema = {
        title: r.displayName,
        subtitle: joinSubtitle("Service account", f["serviceAccountId"]),
        status: { kind: "status-dot", status: "info", label: "Service account" },
        sections: [
          section("Service account", [
            kv([
              ["Service account ID", f["serviceAccountId"], true],
              ["Description", f["description"]],
              ["Created", f["createdAt"]],
            ]),
          ]),
        ],
      };
      break;
    case "api-key":
      schema = {
        title: r.displayName,
        subtitle: joinSubtitle("API key", f["scopeKind"] || f["scope"]),
        status: { kind: "status-dot", status: "info", label: str(f["scope"]) || "API key" },
        sections: [
          section("API key", [
            kv([
              ["Key", f["keyId"], true],
              ["Description", f["description"]],
              ["Owner", f["owner"]],
              ["Owner type", f["ownerKind"]],
              ["Scope", f["scope"]],
              ["Scope type", f["scopeKind"]],
              ["Environment", f["environmentId"]],
              ["Created", f["createdAt"]],
            ]),
            note(
              "Confluent never returns a key's secret after creation. Delete a key to revoke it.",
            ),
          ]),
        ],
      };
      break;
    case "network":
      schema = simpleDetail(
        r,
        "Network",
        [
          ["Network ID", f["networkId"], true],
          ["Connection types", f["connectionTypes"]],
          ["CIDR", f["cidr"]],
          ["Zones", f["zones"]],
          ["DNS domain", f["dnsDomain"], true],
          ["Idle since", f["idleSince"]],
          ["Environment", f["environmentId"]],
        ],
        f["error"] ? [note(str(f["error"]))] : [],
      );
      break;
    case "network-connection":
      schema = simpleDetail(
        r,
        str(f["connectionKind"]) || "Network connection",
        [
          ["Connection ID", f["connectionId"], true],
          ["Kind", f["connectionKind"]],
          ["Network", f["networkId"]],
          ["Environment", f["environmentId"]],
        ],
        f["error"] ? [note(str(f["error"]))] : [],
      );
      break;
    case "encryption-key":
      schema = simpleDetail(r, "Encryption key", [
        ["Key ID", f["keyId"], true],
        ["Provider", f["provider"]],
        ["Key", f["keyReference"], true],
        ["Validation", f["validation"]],
        ["Validation region", f["validationRegion"]],
        ["Created", f["createdAt"]],
      ]);
      break;
    default:
      schema = {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(r.fields).map(([k, v]) => [k, v]))])],
      };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, DEFAULT_METRICS_WINDOW_MS);
}

export function renderConfluentSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const item = (status: ResourceStatus, label: string): SidebarItemSchema => ({
    id: r.id,
    label: r.displayName || r.id,
    status: { kind: "status-dot", status, label },
  });
  switch (r.resourceTypeId) {
    case "kafka-cluster": {
      const phase = str(f["phase"]);
      const size =
        str(f["clusterType"]) === "Dedicated" && f["cku"] !== undefined
          ? `${str(f["cku"])} CKU`
          : str(f["clusterType"]);
      return item(phaseStatus(phase), size || phase || "Cluster");
    }
    case "connector": {
      const state = str(f["state"]);
      return item(connectorStatus(state), state || "Connector");
    }
    case "flink-compute-pool":
    case "ksqldb-cluster":
    case "schema-registry":
    case "network":
    case "network-connection": {
      const phase = str(f["phase"]);
      return item(phaseStatus(phase), phase || str(f["region"]) || "Ready");
    }
    case "api-key":
      return item("info", str(f["scope"]) || "API key");
    case "encryption-key":
      return item(str(f["state"]) === "IN_USE" ? "healthy" : "info", str(f["state"]) || "Key");
    default:
      return item("info", str(f["environmentId"] || f["serviceAccountId"] || r.resourceTypeId));
  }
}
