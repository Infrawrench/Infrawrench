import type {
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  TableRow,
} from "@infrawrench/plugin-base";
import { formatBytes, joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { RESOURCE_TYPES } from "./resource-types.js";

export const DEFAULT_METRICS_WINDOW_MS = 24 * 3_600_000;

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

function bytes(v: unknown): string {
  return typeof v === "number" ? formatBytes(v) : "";
}

function kv(rows: Array<[string, unknown, boolean?]>): SchemaNode {
  const items: KVItem[] = rows
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([key, v, copy]) => ({
      key,
      value: typeof v === "boolean" ? (v ? "Yes" : "No") : String(v),
      ...(copy ? { copyable: true } : {}),
    }));
  return { kind: "key-value-list", items };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function muted(content: string): SchemaNode {
  return { kind: "text", content, variant: "muted" };
}

function uptime(seconds: unknown): string {
  if (typeof seconds !== "number" || seconds <= 0) return "";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function renderEndpoint(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const minio = f["server"] === "MinIO";
  const degraded =
    typeof f["serversOnline"] === "number" &&
    typeof f["serversTotal"] === "number" &&
    f["serversOnline"] < f["serversTotal"];
  return {
    title: r.displayName,
    subtitle: joinSubtitle("S3-compatible endpoint", str(f["server"])),
    status: { kind: "status-dot", status: degraded ? "degraded" : "healthy" },
    sections: [
      section("Endpoint", [
        kv([
          ["URL", f["endpoint"], true],
          ["Region", f["region"], true],
          ["Addressing", f["addressing"]],
          ["Server", f["server"]],
          ["Buckets", f["bucketCount"]],
        ]),
      ]),
      ...(minio
        ? [
            section("MinIO cluster", [
              kv([
                ["Mode", f["minioMode"]],
                ["Version", f["minioVersion"]],
                ["Deployment ID", f["deploymentId"], true],
                ["Objects", f["objects"]],
                ["Used", bytes(f["usedBytes"])],
                ["Capacity", bytes(f["capacityBytes"])],
                ["Free", bytes(f["freeBytes"])],
                [
                  "Servers online",
                  f["serversTotal"] !== undefined
                    ? `${str(f["serversOnline"])} of ${str(f["serversTotal"])}`
                    : "",
                ],
                [
                  "Drives online",
                  f["drivesTotal"] !== undefined
                    ? `${str(f["drivesOnline"])} of ${str(f["drivesTotal"])}`
                    : "",
                ],
                ["Admin API", f["adminApi"]],
              ]),
            ]),
          ]
        : []),
    ],
  };
}

function renderServer(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  let rows: TableRow[] = [];
  try {
    const drives = JSON.parse(str(f["drives"]) || "[]") as Array<{
      path?: string;
      state?: string;
      usedspace?: number;
      totalspace?: number;
      healing?: boolean;
    }>;
    rows = drives.map((d) => ({
      cells: {
        path: d.path ?? "",
        state: `${d.state ?? ""}${d.healing ? " (healing)" : ""}`,
        used: d.usedspace !== undefined ? formatBytes(d.usedspace) : "",
        total: d.totalspace !== undefined ? formatBytes(d.totalspace) : "",
      },
    }));
  } catch {
    rows = [];
  }
  const online = str(f["state"]).toLowerCase() === "online";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("MinIO server", str(f["version"])),
    status: {
      kind: "status-dot",
      status: online ? "healthy" : "error",
      label: str(f["state"]) || "unknown",
    },
    sections: [
      section("Server", [
        kv([
          ["Endpoint", f["endpoint"], true],
          ["State", f["state"]],
          ["Version", f["version"]],
          ["Edition", f["edition"]],
          ["Uptime", uptime(f["uptimeSeconds"])],
          ["Pool", f["pool"]],
          [
            "Drives online",
            f["drivesTotal"] !== undefined
              ? `${str(f["drivesOnline"])} of ${str(f["drivesTotal"])}`
              : "",
          ],
          ["Drives healing", f["drivesHealing"]],
          ["Used", bytes(f["usedBytes"])],
          ["Total", bytes(f["totalBytes"])],
        ]),
      ]),
      section("Drives", [
        rows.length > 0
          ? {
              kind: "table",
              columns: [
                { key: "path", label: "Path", width: "wide", mono: true },
                { key: "state", label: "State" },
                { key: "used", label: "Used" },
                { key: "total", label: "Total" },
              ],
              rows,
            }
          : muted("The admin API reported no drives for this server."),
      ]),
    ],
  };
}

function renderBucket(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const name = str(f["name"]) || r.displayName;
  return {
    title: name,
    subtitle: joinSubtitle("Bucket", str(f["region"])),
    status: { kind: "status-dot", status: "healthy" },
    sections: [
      section("Bucket", [
        kv([
          ["Region", f["region"]],
          ["Created", f["createdAt"]],
          ["Versioning", f["versioning"]],
          ["Object Lock", f["objectLock"]],
          [
            "Default retention",
            f["objectLock"] === true
              ? f["retentionMode"] && f["retentionMode"] !== "none"
                ? `${str(f["retentionMode"])}, ${str(f["retentionDays"])} days`
                : "None"
              : "",
          ],
          ["Tags", f["tags"]],
          ["Bucket policy", f["hasPolicy"]],
          ["Size", bytes(f["sizeBytes"])],
          ["Objects", f["objects"]],
        ]),
      ]),
    ],
    customTabs: [
      { id: "rules", label: "Rules", childResourceTypeIds: ["lifecycle-rule", "cors-rule"] },
    ],
    childTables: [
      {
        title: "Lifecycle rules",
        typeId: "lifecycle-rule",
        onRowClick: "edit",
        columns: [
          { key: "id", label: "Rule", source: { kind: "field", fieldKey: "ruleId" } },
          {
            key: "prefix",
            label: "Prefix",
            source: { kind: "field", fieldKey: "prefix" },
            format: "mono",
          },
          {
            key: "exp",
            label: "Expire after (days)",
            source: { kind: "field", fieldKey: "expirationDays" },
          },
          {
            key: "nc",
            label: "Previous versions (days)",
            source: { kind: "field", fieldKey: "noncurrentDays" },
          },
          {
            key: "on",
            label: "Enabled",
            source: { kind: "field", fieldKey: "enabled" },
            format: "boolean-yesno",
          },
        ],
      },
      {
        title: "CORS rules",
        typeId: "cors-rule",
        onRowClick: "edit",
        columns: [
          { key: "id", label: "Rule", source: { kind: "field", fieldKey: "ruleId" } },
          {
            key: "origins",
            label: "Origins",
            source: { kind: "field", fieldKey: "allowedOrigins" },
          },
          {
            key: "methods",
            label: "Methods",
            source: { kind: "field", fieldKey: "allowedMethods" },
          },
        ],
      },
    ],
    storageBrowser: { bucketName: name },
    bucketPolicyEditor: { bucketArn: `arn:aws:s3:::${name}`, bucketName: name, vendor: "aws-s3" },
  };
}

function renderRule(r: ResourceInstance, kind: "lifecycle" | "cors"): DetailViewSchema {
  const f = r.fields;
  const rows: Array<[string, unknown]> =
    kind === "lifecycle"
      ? [
          ["Bucket", f["bucket"]],
          [
            "Applies to",
            f["prefix"] ? `Objects starting with ${str(f["prefix"])}` : "Every object",
          ],
          ["Enabled", f["enabled"]],
          [
            "Expire current versions after",
            f["expirationDays"] !== undefined ? `${str(f["expirationDays"])} days` : "Never",
          ],
          [
            "Expire previous versions after",
            f["noncurrentDays"] !== undefined ? `${str(f["noncurrentDays"])} days` : "Never",
          ],
          [
            "Abort incomplete uploads after",
            f["abortMultipartDays"] !== undefined
              ? `${str(f["abortMultipartDays"])} days`
              : "Never",
          ],
        ]
      : [
          ["Bucket", f["bucket"]],
          ["Allowed origins", f["allowedOrigins"]],
          ["Allowed methods", f["allowedMethods"]],
          ["Allowed headers", f["allowedHeaders"]],
          ["Exposed headers", f["exposeHeaders"]],
          ["Max age", f["maxAgeSeconds"] !== undefined ? `${str(f["maxAgeSeconds"])} s` : ""],
        ];
  return {
    title: r.displayName,
    subtitle: joinSubtitle(kind === "lifecycle" ? "Lifecycle rule" : "CORS rule", str(f["bucket"])),
    sections: [section("Rule", [kv(rows)])],
  };
}

export function renderS3Detail(r: ResourceInstance): DetailViewSchema {
  let schema: DetailViewSchema;
  switch (r.resourceTypeId) {
    case "endpoint":
      schema = renderEndpoint(r);
      break;
    case "minio-server":
      schema = renderServer(r);
      break;
    case "bucket":
      schema = renderBucket(r);
      break;
    case "lifecycle-rule":
      schema = renderRule(r, "lifecycle");
      break;
    case "cors-rule":
      schema = renderRule(r, "cors");
      break;
    default:
      schema = {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(r.fields))])],
      };
  }
  // Metrics here are point-in-time readings of the admin API, not a window.
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, DEFAULT_METRICS_WINDOW_MS);
}

export function renderS3Sidebar(r: ResourceInstance): SidebarItemSchema {
  if (r.resourceTypeId === "minio-server") {
    const online = str(r.fields["state"]).toLowerCase() === "online";
    return {
      id: r.id,
      label: r.displayName || r.id,
      status: { kind: "status-dot", status: online ? "healthy" : "error" },
    };
  }
  return { id: r.id, label: r.displayName || r.externalId || r.id };
}
