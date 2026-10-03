import type {
  DetailViewSchema,
  ResourceInstance,
  ResourceStatus,
  ResourceTypeDefinition,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  SqlTableMeta,
} from "@infrawrench/plugin-base";
import { labeledFieldItems } from "@infrawrench/plugin-base";

/**
 * Detail views for Basin (Pipelines streams/sinks/pipelines, Catalog,
 * tables) and Workers Analytics Engine datasets. The SQL-capable types
 * (catalog, table, dataset) declare `sqlEditor`, so the host's SQL tab runs
 * through the plugin's `executeQuery`, the same path BigQuery uses.
 */

const REFRESH = {
  kind: "action" as const,
  label: "Refresh",
  action: { type: "refresh-resource" as const },
};

function parseTables(resource: ResourceInstance): SqlTableMeta[] {
  const raw = resource.resolvedOutputs?.["__tables__"];
  if (typeof raw !== "string" || !raw) return [];
  try {
    return JSON.parse(raw) as SqlTableMeta[];
  } catch {
    return [];
  }
}

function detailsSection(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
  title: string,
  omit: string[] = [],
): SectionNode {
  const fields = Object.fromEntries(
    Object.entries(resource.fields).filter(([k]) => !omit.includes(k)),
  );
  return {
    kind: "section",
    title,
    children: [
      {
        kind: "key-value-list",
        items: labeledFieldItems(fields, resourceTypes, resource.resourceTypeId),
      },
    ],
  };
}

function snippet(title: string, intro: string, code: string): SectionNode {
  return {
    kind: "section",
    title,
    children: [
      { kind: "text", content: intro, variant: "muted" },
      { kind: "text", content: code, variant: "mono", copyable: true },
    ],
  };
}

export function pipelineStatus(status: string): { status: ResourceStatus; label: string } {
  const s = status.toLowerCase();
  if (["running", "active", "healthy"].includes(s)) return { status: "healthy", label: status };
  if (["failed", "error", "errored"].includes(s)) return { status: "error", label: status };
  if (["pending", "provisioning", "starting", "creating", "deploying"].includes(s))
    return { status: "provisioning", label: status };
  if (["stopped", "paused"].includes(s)) return { status: "degraded", label: status };
  return { status: "info", label: status || "Unknown" };
}

export function renderBasinPipelineDetail(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
): DetailViewSchema {
  const sql = String(resource.fields["sql"] ?? "");
  const failure = String(resource.fields["failureReason"] ?? "");
  const sections: SectionNode[] = [
    detailsSection(resource, resourceTypes, "Pipeline Details", ["sql", "failureReason"]),
  ];
  if (failure) {
    sections.push({
      kind: "section",
      title: "Failure",
      children: [{ kind: "text", content: failure }],
    });
  }
  if (sql) {
    sections.push({
      kind: "section",
      title: "SQL",
      children: [
        { kind: "text", content: sql, variant: "mono", copyable: true },
        {
          kind: "text",
          content:
            "Cloudflare doesn't allow editing a pipeline's SQL. To change it, create a new pipeline with the new SQL and delete this one.",
          variant: "muted",
        },
      ],
    });
  }
  return {
    title: resource.displayName,
    subtitle: "Basin Pipeline",
    status: { kind: "status-dot", ...pipelineStatus(String(resource.fields["status"] ?? "")) },
    sections,
    headerActions: [REFRESH],
  };
}

export function renderBasinStreamDetail(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
): DetailViewSchema {
  const f = resource.fields;
  const endpoint = String(f["endpoint"] ?? "");
  const streamId = resource.externalId ?? "";
  const httpOn = Boolean(f["httpEnabled"]);
  const auth = Boolean(f["httpAuthentication"]);
  const sections: SectionNode[] = [detailsSection(resource, resourceTypes, "Stream Details")];
  if (httpOn && endpoint) {
    const authLine = auth ? `  -H "Authorization: Bearer $PIPELINES_SEND_TOKEN" \\\n` : "";
    sections.push(
      snippet(
        "Send Events over HTTP",
        auth
          ? "The endpoint requires a Cloudflare API token with the Pipelines Send permission."
          : "The endpoint accepts unauthenticated requests. Turn on token auth with Edit.",
        `curl -X POST ${endpoint} \\\n  -H "Content-Type: application/json" \\\n${authLine}  -d '[{"event": "test"}]'`,
      ),
    );
  }
  if (f["workerBinding"]) {
    sections.push(
      snippet(
        "Send Events from a Worker",
        "Add the binding to your Wrangler config, then call send() with an array of records.",
        `[[pipelines]]\nbinding = "STREAM"\nstream = "${streamId}"\n\n// in your Worker\nawait env.STREAM.send([{ event: "test" }]);`,
      ),
    );
  }
  return {
    title: resource.displayName,
    subtitle: "Basin Stream",
    status: {
      kind: "status-dot",
      status: httpOn || f["workerBinding"] ? "healthy" : "info",
      label: httpOn || f["workerBinding"] ? "Accepting events" : "Ingest disabled",
    },
    sections,
    headerActions: [REFRESH],
  };
}

export function renderBasinSinkDetail(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
): DetailViewSchema {
  const blankless = {
    ...resource,
    fields: Object.fromEntries(Object.entries(resource.fields).filter(([, v]) => v !== "")),
  };
  return {
    title: resource.displayName,
    subtitle: "Basin Sink",
    status: { kind: "status-dot", status: "info", label: String(resource.fields["type"] ?? "") },
    sections: [
      detailsSection(blankless, resourceTypes, "Sink Details"),
      {
        kind: "section",
        children: [
          {
            kind: "text",
            content:
              "Cloudflare doesn't allow editing a sink. To change it, create a new sink and a pipeline that writes to it, then delete this one.",
            variant: "muted",
          },
        ],
      },
    ],
    headerActions: [REFRESH],
  };
}

export function renderBasinCatalogDetail(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
): DetailViewSchema {
  const f = resource.fields;
  const active = String(f["status"] ?? "") === "active";
  const tables = parseTables(resource);
  const first = tables[0]?.name ?? "namespace.table_name";
  const uri = String(f["catalogUri"] ?? "");
  const warehouse = String(f["warehouseName"] ?? "");
  const sections: SectionNode[] = [
    detailsSection(resource, resourceTypes, "Catalog Details", ["maintenanceToken"]),
  ];
  if (tables.length > 0) {
    sections.push({
      kind: "section",
      title: `Tables (${tables.length})`,
      children: [
        {
          kind: "table",
          columns: [{ key: "name", label: "Table", mono: true }],
          rows: tables.map((t) => ({ cells: { name: t.name } })),
        },
      ],
    });
  }
  if (uri) {
    sections.push(
      snippet(
        "Connect an Iceberg Engine",
        "PyIceberg example. Spark, DuckDB, Trino, Snowflake and StarRocks take the same URI and warehouse; the token needs Workers R2 Data Catalog and R2 Storage access.",
        `from pyiceberg.catalog.rest import RestCatalog\n\ncatalog = RestCatalog(\n    name="basin",\n    warehouse="${warehouse}",\n    uri="${uri}",\n    token=CLOUDFLARE_API_TOKEN,\n)`,
      ),
    );
  }
  const schema: DetailViewSchema = {
    title: resource.displayName,
    subtitle: "Basin Catalog",
    status: {
      kind: "status-dot",
      status: active ? "healthy" : "info",
      label: active ? "Active" : String(f["status"] || "Inactive"),
    },
    sections,
    headerActions: [REFRESH],
  };
  if (active) {
    schema.sqlEditor = {
      connectionStringOutputKey: "warehouseName",
      defaultQuery: `SELECT * FROM ${first} LIMIT 10`,
      tables,
    };
  }
  return schema;
}

export function renderBasinTableDetail(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
): DetailViewSchema {
  const qualified = String(resource.resolvedOutputs["tableName"] ?? resource.displayName);
  const tables = parseTables(resource);
  return {
    title: resource.displayName,
    subtitle: "Basin Table",
    status: { kind: "status-dot", status: "healthy", label: "Iceberg" },
    sections: [detailsSection(resource, resourceTypes, "Table Details")],
    headerActions: [REFRESH],
    sqlEditor: {
      connectionStringOutputKey: "tableName",
      defaultQuery: `SELECT * FROM ${qualified} LIMIT 10`,
      tables: tables.length > 0 ? tables : [{ name: qualified, columns: [] }],
    },
  };
}

export function renderAnalyticsEngineDatasetDetail(resource: ResourceInstance): DetailViewSchema {
  const name = resource.externalId ?? resource.displayName;
  const tables = parseTables(resource);
  const ident = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name}"`;
  const children: SchemaNode[] = [
    {
      kind: "key-value-list",
      items: [{ key: "Dataset", value: name, copyable: true }],
    },
  ];
  return {
    title: resource.displayName,
    subtitle: "Analytics Engine Dataset",
    status: { kind: "status-dot", status: "healthy", label: "Receiving data" },
    sections: [
      { kind: "section", title: "Dataset Details", children },
      snippet(
        "Write Data Points from a Worker",
        "Bind the dataset in your Wrangler config, then call writeDataPoint(). Up to 20 blobs, 20 doubles and one index per point; data is kept for three months.",
        `[[analytics_engine_datasets]]\nbinding = "ANALYTICS"\ndataset = "${name}"\n\n// in your Worker\nenv.ANALYTICS.writeDataPoint({\n  indexes: ["customer-id"],\n  blobs: ["/path", "GET"],\n  doubles: [1, 42.5],\n});`,
      ),
      {
        kind: "section",
        title: "Query Tips",
        children: [
          {
            kind: "text",
            content:
              "Rows are sampled under load. Weight counts and sums by _sample_interval, e.g. SUM(_sample_interval) for an event count. Supports SELECT, SHOW TABLES and SHOW TIMEZONES.",
            variant: "muted",
          },
        ],
      },
    ],
    headerActions: [REFRESH],
    sqlEditor: {
      connectionStringOutputKey: "datasetName",
      defaultQuery:
        `SELECT toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour, ` +
        `SUM(_sample_interval) AS events\nFROM ${ident}\n` +
        `WHERE timestamp > NOW() - INTERVAL '1' DAY\nGROUP BY hour\nORDER BY hour`,
      tables,
    },
  };
}

export function renderBasinSidebarItem(resource: ResourceInstance): SidebarItemSchema | null {
  switch (resource.resourceTypeId) {
    case "basin-pipeline": {
      const s = pipelineStatus(String(resource.fields["status"] ?? ""));
      return { id: resource.id, label: resource.displayName, status: { kind: "status-dot", ...s } };
    }
    case "basin-catalog": {
      const active = String(resource.fields["status"] ?? "") === "active";
      return {
        id: resource.id,
        label: resource.displayName,
        status: {
          kind: "status-dot",
          status: active ? "healthy" : "info",
          label: active ? "Active" : "Inactive",
        },
      };
    }
    default:
      return null;
  }
}
