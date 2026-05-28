import type {
  ResourceInstance,
  DetailViewSchema,
  SectionNode,
  SqlTableMeta,
} from "@infrawrench/plugin-base";

export function renderR2BucketDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  return {
    title: resource.displayName,
    subtitle: "R2 Object Storage",
    status: { kind: "status-dot", status: "healthy", label: "Active" },
    sections: [
      {
        kind: "section",
        title: "Bucket Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(fields["name"] ?? ""), copyable: true },
              ...(fields["location"]
                ? [{ key: "Location Hint", value: String(fields["location"]) }]
                : []),
              ...(fields["createdOn"]
                ? [{ key: "Created", value: String(fields["createdOn"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    storageBrowser: { bucketName: String(fields["name"] ?? "") },
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderKVNamespaceDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  return {
    title: resource.displayName,
    subtitle: "Workers KV Namespace",
    status: { kind: "status-dot", status: "healthy", label: "Active" },
    sections: [
      {
        kind: "section",
        title: "Namespace Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Title", value: String(fields["title"] ?? ""), copyable: true },
              { key: "Namespace ID", value: resource.externalId ?? "", copyable: true },
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    kvBrowser: { defaultPageSize: 100 },
  };
}

export function renderD1DatabaseDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  let tables: SqlTableMeta[] = [];
  const tablesJson = resource.resolvedOutputs?.["__tables__"];
  if (typeof tablesJson === "string" && tablesJson.length > 0) {
    try {
      tables = JSON.parse(tablesJson) as SqlTableMeta[];
    } catch {
      /* ignore malformed introspection payload */
    }
  }
  return {
    title: resource.displayName,
    subtitle: "D1 SQLite Database",
    status: { kind: "status-dot", status: "healthy", label: "Active" },
    sections: [
      {
        kind: "section",
        title: "Database Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(fields["name"] ?? ""), copyable: true },
              { key: "Database ID", value: resource.externalId ?? "", copyable: true },
              ...(fields["version"] ? [{ key: "Version", value: String(fields["version"]) }] : []),
              ...(fields["numTables"] !== undefined
                ? [{ key: "Tables", value: String(fields["numTables"]) }]
                : []),
              ...(fields["fileSize"]
                ? [{ key: "File Size", value: String(fields["fileSize"]) }]
                : []),
              ...(fields["createdAt"]
                ? [{ key: "Created", value: String(fields["createdAt"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    sqlEditor: {
      connectionStringOutputKey: "databaseId",
      defaultQuery: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;",
      tables,
    },
  };
}

interface ParsedQueueConsumer {
  consumerId: string;
  type: string;
  scriptName?: string;
  deadLetterQueue?: string;
  createdOn?: string;
  batchSize?: number;
  maxConcurrency?: number | null;
  maxRetries?: number;
  maxWaitTimeMs?: number;
  retryDelay?: number;
  visibilityTimeoutMs?: number;
}

export function renderQueueDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const paused = Boolean(fields["deliveryPaused"]);

  let consumers: ParsedQueueConsumer[] = [];
  const consumersJson = resource.resolvedOutputs?.["__consumers__"];
  if (typeof consumersJson === "string" && consumersJson.length > 0) {
    try {
      consumers = JSON.parse(consumersJson) as ParsedQueueConsumer[];
    } catch {
      /* ignore malformed consumer payload */
    }
  }

  const overviewSection: SectionNode = {
    kind: "section",
    title: "Queue Details",
    children: [
      {
        kind: "key-value-list",
        items: [
          { key: "Name", value: String(fields["name"] ?? ""), copyable: true },
          { key: "Queue ID", value: resource.externalId ?? "", copyable: true },
          ...(fields["producersTotal"] !== undefined
            ? [{ key: "Producers", value: String(fields["producersTotal"]) }]
            : []),
          ...(fields["consumersTotal"] !== undefined
            ? [{ key: "Consumers", value: String(fields["consumersTotal"]) }]
            : []),
          ...(fields["createdOn"] ? [{ key: "Created", value: String(fields["createdOn"]) }] : []),
          ...(fields["modifiedOn"]
            ? [{ key: "Modified", value: String(fields["modifiedOn"]) }]
            : []),
        ],
      },
    ],
  };

  const settingsSection: SectionNode = {
    kind: "section",
    title: "Settings",
    children: [
      {
        kind: "key-value-list",
        items: [
          { key: "Delivery Delay", value: `${Number(fields["deliveryDelay"] ?? 0)} s` },
          {
            key: "Retention Period",
            value: `${Number(fields["messageRetentionPeriod"] ?? 0)} s`,
          },
          { key: "Delivery Paused", value: paused ? "Yes" : "No" },
        ],
      },
    ],
  };

  const consumersTable: SectionNode = {
    kind: "section",
    title: consumers.length > 0 ? "Consumers" : "No consumers configured",
    children:
      consumers.length === 0
        ? [
            {
              kind: "text",
              content:
                "Bind this queue to a Worker (or set up a pull consumer) to start processing messages. New consumers show up here on next refresh.",
              variant: "muted",
            },
          ]
        : [
            {
              kind: "table",
              columns: [
                { key: "name", label: "Consumer", width: "wide" },
                { key: "type", label: "Type", width: "narrow" },
                { key: "batch", label: "Batch", width: "narrow" },
                { key: "retries", label: "Retries", width: "narrow" },
                { key: "retryDelay", label: "Retry Delay", width: "narrow" },
                { key: "dlq", label: "Dead Letter Queue", width: "wide" },
              ],
              rows: consumers.map((c) => ({
                cells: {
                  name: c.scriptName ?? c.consumerId ?? "(pull)",
                  type: c.type,
                  batch: c.batchSize !== undefined ? String(c.batchSize) : "—",
                  retries: c.maxRetries !== undefined ? String(c.maxRetries) : "—",
                  retryDelay: c.retryDelay !== undefined ? `${c.retryDelay} s` : "—",
                  dlq: c.deadLetterQueue && c.deadLetterQueue.length > 0 ? c.deadLetterQueue : "—",
                },
              })),
            },
          ],
  };

  return {
    title: resource.displayName,
    subtitle: "Cloudflare Queue",
    status: {
      kind: "status-dot",
      status: paused ? "degraded" : "healthy",
      label: paused ? "Delivery paused" : "Active",
    },
    sections: [overviewSection, settingsSection],
    customTabs: [
      {
        id: "consumers",
        label: `Consumers${consumers.length > 0 ? ` (${consumers.length})` : ""}`,
        sections: [consumersTable],
      },
    ],
    publishPanel: {
      tabLabel: "Publish",
      subtitle: `Push a test message to ${resource.displayName}`,
      bodyFormat: "json",
      defaultBody: '{\n  "hello": "world"\n}',
      helpText:
        "Pushed via the Cloudflare Queues HTTP API. Workers bound as consumers will receive the message on their next batch.",
      submitLabel: "Push message",
      extraFields: [
        {
          key: "format",
          label: "Body format",
          kind: "select",
          defaultValue: "json",
          options: [
            { value: "json", label: "JSON" },
            { value: "text", label: "Plain text" },
          ],
          helpText: "Sent as the `content_type` field on the push call.",
        },
        {
          key: "delaySeconds",
          label: "Delay (seconds)",
          kind: "number",
          placeholder: "0",
          optional: true,
          helpText: "Optional — delay before the message becomes available to consumers.",
        },
      ],
    },
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderHyperdriveDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  return {
    title: resource.displayName,
    subtitle: "Hyperdrive Connection Cache",
    status: { kind: "status-dot", status: "healthy", label: "Active" },
    sections: [
      {
        kind: "section",
        title: "Configuration",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(fields["name"] ?? ""), copyable: true },
              { key: "Config ID", value: resource.externalId ?? "", copyable: true },
              ...(fields["originHost"]
                ? [{ key: "Origin Host", value: String(fields["originHost"]) }]
                : []),
              ...(fields["originPort"] !== undefined
                ? [{ key: "Origin Port", value: String(fields["originPort"]) }]
                : []),
              ...(fields["originScheme"]
                ? [{ key: "Scheme", value: String(fields["originScheme"]) }]
                : []),
              ...(fields["database"]
                ? [{ key: "Database", value: String(fields["database"]) }]
                : []),
              ...(fields["user"] ? [{ key: "User", value: String(fields["user"]) }] : []),
              ...(fields["cachingDisabled"] !== undefined
                ? [{ key: "Caching", value: fields["cachingDisabled"] ? "Disabled" : "Enabled" }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}
