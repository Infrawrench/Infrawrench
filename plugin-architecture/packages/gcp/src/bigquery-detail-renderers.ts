/**
 * Detail renderers for BigQuery resources (datasets and tables).
 */
import type { DetailViewSchema, ResourceInstance, SqlTableMeta } from "@infrawrench/plugin-base";
import { bigQuerySchemaToRows } from "./shared-renderers.js";

/** Apply the BigQuery dataset renderer to `base`. */
export function renderBigQueryDataset(resource: ResourceInstance, base: DetailViewSchema): void {
  const fields = resource.fields;
  const datasetId = String(resource.fields["name"] ?? "");
  const friendlyName = String(fields["friendlyName"] ?? "");
  const location = String(fields["location"] ?? "");
  const description = String(fields["description"] ?? "");
  const labels = String(fields["labels"] ?? "");
  const defaultCollation = String(fields["defaultCollation"] ?? "");
  const defaultRoundingMode = String(fields["defaultRoundingMode"] ?? "");
  const storageBillingModel = String(fields["storageBillingModel"] ?? "");
  const maxTimeTravelHours = Number(fields["maxTimeTravelHours"] ?? 0);
  const defaultTableExpirationMs = Number(fields["defaultTableExpirationMs"] ?? 0);
  const defaultPartitionExpirationMs = Number(fields["defaultPartitionExpirationMs"] ?? 0);
  const isCaseInsensitive = Boolean(fields["isCaseInsensitive"]);
  const creationTime = String(fields["creationTime"] ?? "");
  const lastModifiedTime = String(fields["lastModifiedTime"] ?? "");

  base.subtitle = location ? `BigQuery · ${location}` : "BigQuery Dataset";
  base.status = { kind: "status-dot", status: "healthy", label: "Active" };
  base.sections = [
    {
      kind: "section",
      title: "Dataset Info",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Dataset ID", value: datasetId, copyable: true },
            ...(friendlyName ? [{ key: "Friendly Name", value: friendlyName }] : []),
            ...(location ? [{ key: "Location", value: location }] : []),
            ...(description ? [{ key: "Description", value: description }] : []),
            ...(labels ? [{ key: "Labels", value: labels }] : []),
            ...(creationTime ? [{ key: "Created", value: creationTime }] : []),
            ...(lastModifiedTime ? [{ key: "Last modified", value: lastModifiedTime }] : []),
          ],
        },
      ],
    },
    {
      kind: "section",
      title: "Default Settings",
      children: [
        {
          kind: "key-value-list",
          items: [
            ...(defaultTableExpirationMs > 0
              ? [
                  {
                    key: "Default table expiration",
                    value: `${defaultTableExpirationMs} ms`,
                  },
                ]
              : [{ key: "Default table expiration", value: "Never" }]),
            ...(defaultPartitionExpirationMs > 0
              ? [
                  {
                    key: "Default partition expiration",
                    value: `${defaultPartitionExpirationMs} ms`,
                  },
                ]
              : []),
            ...(defaultCollation ? [{ key: "Default collation", value: defaultCollation }] : []),
            ...(defaultRoundingMode
              ? [{ key: "Default rounding mode", value: defaultRoundingMode }]
              : []),
            { key: "Case insensitive", value: isCaseInsensitive ? "Yes" : "No" },
            ...(storageBillingModel
              ? [{ key: "Storage billing model", value: storageBillingModel }]
              : []),
            ...(maxTimeTravelHours > 0
              ? [{ key: "Max time travel", value: `${maxTimeTravelHours} hours` }]
              : []),
          ],
        },
      ],
    },
  ];

  const tablesJson = resource.resolvedOutputs["__tables__"] ?? "[]";
  const tables: SqlTableMeta[] = (() => {
    try {
      return JSON.parse(tablesJson) as SqlTableMeta[];
    } catch {
      return [];
    }
  })();
  base.sqlEditor = {
    connectionStringOutputKey: "__bigquery__",
    defaultQuery: `SELECT * FROM \`${datasetId}.INFORMATION_SCHEMA.TABLES\` LIMIT 20`,
    tables,
    supportsQueryCost: true,
  };
}

/** Apply the BigQuery table renderer to `base`. */
export function renderBigQueryTable(resource: ResourceInstance, base: DetailViewSchema): void {
  const fields = resource.fields;
  const tableId = String(fields["name"] ?? "");
  const friendlyName = String(fields["friendlyName"] ?? "");
  const type = String(fields["type"] ?? "TABLE");
  const location = String(fields["location"] ?? "");
  const description = String(fields["description"] ?? "");
  const labels = String(fields["labels"] ?? "");
  const creationTime = String(fields["creationTime"] ?? "");
  const lastModifiedTime = String(fields["lastModifiedTime"] ?? "");
  const expirationTime = String(fields["expirationTime"] ?? "NEVER");
  const primaryKeys = String(fields["primaryKeys"] ?? "");
  const partitioning = String(fields["partitioning"] ?? "");
  const clusteringFields = String(fields["clusteringFields"] ?? "");
  const defaultCollation = String(fields["defaultCollation"] ?? "");
  const defaultRoundingMode = String(fields["defaultRoundingMode"] ?? "");
  const caseInsensitive = Boolean(fields["caseInsensitive"]);

  base.subtitle = type ? `BigQuery ${type.toLowerCase()}` : "BigQuery Table";
  base.status = { kind: "status-dot", status: "healthy", label: type };
  base.sections = [
    {
      kind: "section",
      title: "Table Details",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Table ID", value: tableId, copyable: true },
            ...(friendlyName ? [{ key: "Friendly Name", value: friendlyName }] : []),
            { key: "Type", value: type },
            ...(location ? [{ key: "Data location", value: location }] : []),
            ...(creationTime ? [{ key: "Created", value: creationTime }] : []),
            ...(lastModifiedTime ? [{ key: "Last modified", value: lastModifiedTime }] : []),
            { key: "Table expiration", value: expirationTime },
            ...(description ? [{ key: "Description", value: description }] : []),
            ...(labels ? [{ key: "Labels", value: labels }] : []),
            ...(primaryKeys ? [{ key: "Primary key(s)", value: primaryKeys }] : []),
            ...(partitioning ? [{ key: "Partitioning", value: partitioning }] : []),
            ...(clusteringFields ? [{ key: "Clustering", value: clusteringFields }] : []),
            ...(defaultCollation ? [{ key: "Default collation", value: defaultCollation }] : []),
            ...(defaultRoundingMode
              ? [{ key: "Default rounding mode", value: defaultRoundingMode }]
              : []),
            ...(caseInsensitive !== undefined
              ? [{ key: "Case insensitive", value: caseInsensitive ? "Yes" : "No" }]
              : []),
          ],
        },
      ],
    },
    {
      kind: "section",
      title: "Storage Info",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Number of rows", value: String(fields["numRows"] ?? "0") },
            { key: "Total logical bytes", value: String(fields["numBytes"] ?? "0 B") },
            {
              key: "Active logical bytes",
              value: String(fields["numActiveLogicalBytes"] ?? "0 B"),
            },
            {
              key: "Long term logical bytes",
              value: String(fields["numLongTermLogicalBytes"] ?? "0 B"),
            },
            {
              key: "Current physical bytes",
              value: String(fields["numCurrentPhysicalBytes"] ?? "0 B"),
            },
            {
              key: "Total physical bytes",
              value: String(fields["numTotalPhysicalBytes"] ?? "0 B"),
            },
            {
              key: "Active physical bytes",
              value: String(fields["numActivePhysicalBytes"] ?? "0 B"),
            },
            {
              key: "Long term physical bytes",
              value: String(fields["numLongTermPhysicalBytes"] ?? "0 B"),
            },
            {
              key: "Time travel physical bytes",
              value: String(fields["numTimeTravelPhysicalBytes"] ?? "0 B"),
            },
          ],
        },
      ],
    },
  ];

  const schemaJson = String(fields["schemaJson"] ?? "");
  if (schemaJson) {
    const schemaRows = bigQuerySchemaToRows(schemaJson);
    if (schemaRows.length > 0) {
      base.sections.push({
        kind: "section",
        title: "Schema",
        children: [
          {
            kind: "table",
            emphasizeFirstColumn: true,
            columns: [
              { key: "name", label: "Field name", mono: true },
              { key: "type", label: "Type", width: "narrow" },
              { key: "mode", label: "Mode", width: "narrow" },
              { key: "description", label: "Description" },
            ],
            rows: schemaRows,
          },
        ],
      });
    } else {
      base.sections.push({
        kind: "section",
        title: "Schema",
        children: [{ kind: "text", content: schemaJson, variant: "mono" }],
      });
    }
  }
}
