import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { regionOption } from "./regions.js";
import type { GcpCreateContext } from "./create-context.js";

export const bigqueryCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "bigquery-dataset": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "datasetId",
          label: "Dataset ID",
          kind: "text",
          required: true,
          description: "Letters, numbers, underscores (e.g. my_dataset)",
        },
        {
          key: "location",
          label: "Location",
          kind: "region-picker",
          required: true,
          regions: [
            { id: "US", label: "US (multi-region)" },
            { id: "EU", label: "EU (multi-region)" },
            regionOption("us-central1"),
            regionOption("us-east1"),
            regionOption("europe-west1"),
            regionOption("europe-west4"),
            regionOption("asia-east1"),
          ],
          defaultValue: "US",
        },
      ],
    };
  },
  "bigquery-table": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "datasetId",
          label: "Dataset ID",
          kind: "text",
          required: true,
          description:
            "The parent dataset. When creating from a dataset's detail view, this is prefilled.",
        },
        {
          key: "tableId",
          label: "Table ID",
          kind: "text",
          required: true,
          description: "Letters, numbers, underscores (e.g. events)",
        },
        {
          key: "schemaJson",
          label: "Schema (JSON)",
          kind: "text",
          required: false,
          multiline: true,
          description:
            "BigQuery schema as a JSON array of fields. Leave blank to create an empty table.",
          placeholder:
            '[\n  {"name": "id", "type": "STRING", "mode": "REQUIRED"},\n  {"name": "created_at", "type": "TIMESTAMP"}\n]',
        },
        {
          key: "description",
          label: "Description",
          kind: "text",
          required: false,
        },
        {
          key: "expirationMs",
          label: "Table expiration (blank = never)",
          kind: "datetime",
          datetimeMode: "epoch-ms",
          required: false,
        },
      ],
    };
  },
};

export const bigqueryCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "bigquery-dataset": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const datasetId = fields["datasetId"] ?? "";
    const location = fields["location"] ?? "US";

    const res = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${p}/datasets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        datasetReference: { projectId: p, datasetId },
        location,
      }),
    });
    if (!res.ok) throw new Error(`BigQuery API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "bigquery-dataset", `${p}:${datasetId}`),
      pluginId: "gcp",
      resourceTypeId: "bigquery-dataset",
      accountId,
      displayName: datasetId,
      fields: {
        name: datasetId,
        location,
        description: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${p}:${datasetId}`,
      createdAt: now,
      updatedAt: now,
    };
  },
  "bigquery-table": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const datasetId = fields["datasetId"] ?? "";
    const tableId = fields["tableId"] ?? "";
    const description = fields["description"] ?? "";
    const schemaJson = fields["schemaJson"] ?? "";
    const expirationMs = fields["expirationMs"] ?? "";
    if (!datasetId || !tableId)
      throw new Error("BigQuery table creation requires datasetId and tableId");

    const body: Record<string, unknown> = {
      tableReference: { projectId: p, datasetId, tableId },
    };
    if (description) body["description"] = description;
    if (expirationMs) body["expirationTime"] = expirationMs;
    if (schemaJson.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(schemaJson);
      } catch (e) {
        throw new Error(`Schema JSON is not valid JSON: ${(e as Error).message}`);
      }
      if (!Array.isArray(parsed))
        throw new Error("Schema JSON must be an array of field definitions");
      body["schema"] = { fields: parsed };
    }

    const res = await fetch(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${p}/datasets/${datasetId}/tables`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`BigQuery API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const externalId = `${p}:${datasetId}/${tableId}`;
    return {
      id: ctx.id(accountId, "bigquery-table", externalId),
      pluginId: "gcp",
      resourceTypeId: "bigquery-table",
      accountId,
      displayName: tableId,
      parentResourceId: ctx.id(accountId, "bigquery-dataset", `${p}:${datasetId}`),
      fields: {
        name: tableId,
        type: "TABLE",
        description,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId,
      createdAt: now,
      updatedAt: now,
    };
  },
};
