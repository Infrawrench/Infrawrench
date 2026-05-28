import type {
  ResourceInstance,
  DetailViewSchema,
  SectionNode,
  ResourceStatus,
  ResourceTypeDefinition,
  SqlTableMeta,
} from "@infrawrench/plugin-base";
import { dnsZoneStatus, formatDnsTtl, labeledFieldItems } from "@infrawrench/plugin-base";

export function tunnelStatus(status: string): ResourceStatus {
  switch (status) {
    case "healthy":
      return "healthy";
    case "active":
      return "healthy";
    case "degraded":
      return "degraded";
    case "inactive":
      return "error";
    case "down":
      return "error";
    default:
      return "info";
  }
}

export function deploymentStatus(status: string): ResourceStatus {
  switch (status) {
    case "success":
      return "healthy";
    case "active":
      return "healthy";
    case "failure":
      return "error";
    case "idle":
      return "info";
    default:
      return "provisioning";
  }
}

export function sslStatus(status: string): ResourceStatus {
  switch (status) {
    case "active":
      return "healthy";
    case "pending_validation":
      return "provisioning";
    case "pending_issuance":
      return "provisioning";
    case "pending_deployment":
      return "provisioning";
    case "expired":
      return "error";
    case "deleted":
      return "error";
    default:
      return "info";
  }
}

export function renderZoneDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const status = String(fields["status"] ?? "");
  const nameservers = String(fields["nameservers"] ?? "");
  const nsList = nameservers.split(", ").filter(Boolean);

  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Zone Info",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Domain", value: String(fields["name"] ?? "") },
            { key: "Status", value: status },
            { key: "Plan", value: String(fields["plan"] ?? "Free") },
            { key: "Type", value: String(fields["type"] ?? "full") },
            ...(fields["paused"] ? [{ key: "Paused", value: "Yes" }] : []),
          ],
        },
      ],
    },
  ];

  if (nsList.length > 0) {
    sections.push({
      kind: "section",
      title: "Nameservers",
      children: [
        {
          kind: "key-value-list",
          items: nsList.map((ns, i) => ({
            key: `NS ${i + 1}`,
            value: ns,
            copyable: true,
          })),
        },
        {
          kind: "text",
          content: "Point your domain registrar to these nameservers to activate Cloudflare.",
          variant: "muted",
        },
      ],
    });
  }

  return {
    title: resource.displayName,
    subtitle: `Zone · ${String(fields["plan"] ?? "Free")}`,
    status: { kind: "status-dot", status: dnsZoneStatus(status), label: status },
    sections,
    childTables: [
      {
        title: "DNS Records",
        typeId: "dns-record",
        emptyText: "No DNS records in this zone yet.",
        columns: [
          {
            key: "type",
            label: "Type",
            width: "narrow",
            source: { kind: "field", fieldKey: "type" },
            format: "type-badge",
          },
          {
            key: "name",
            label: "Name",
            width: "auto",
            source: { kind: "field", fieldKey: "name" },
            stripSuffixFromFieldKey: "zoneName",
          },
          {
            key: "content",
            label: "Content",
            width: "wide",
            source: { kind: "field", fieldKey: "content" },
            format: "mono",
          },
          {
            key: "proxied",
            label: "Proxy",
            width: "narrow",
            source: { kind: "field", fieldKey: "proxied" },
            format: "proxy-status",
          },
          {
            key: "ttl",
            label: "TTL",
            width: "narrow",
            source: { kind: "field", fieldKey: "ttl" },
            format: "ttl",
          },
        ],
      },
    ],
    manifestEditor: { language: "json", resourceKind: "Zone Settings" },
    headerActions: [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      {
        kind: "action",
        label: "Open in Cloudflare",
        action: {
          type: "open-url",
          url: `https://dash.cloudflare.com/${resource.externalId ?? ""}`,
        },
      },
    ],
  };
}

export function renderWorkerDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  return {
    title: resource.displayName,
    subtitle: "Worker Script",
    status: { kind: "status-dot", status: "healthy", label: "Deployed" },
    sections: [
      {
        kind: "section",
        title: "Worker Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(fields["name"] ?? ""), copyable: true },
              ...(fields["compatibilityDate"]
                ? [{ key: "Compatibility Date", value: String(fields["compatibilityDate"]) }]
                : []),
              ...(fields["createdOn"]
                ? [{ key: "Created", value: String(fields["createdOn"]) }]
                : []),
              ...(fields["modifiedOn"]
                ? [{ key: "Modified", value: String(fields["modifiedOn"]) }]
                : []),
              ...(fields["routes"] ? [{ key: "Routes", value: String(fields["routes"]) }] : []),
            ],
          },
        ],
      },
    ],
    manifestEditor: { language: "json", resourceKind: "Worker Settings", readOnly: true },
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderWorkersAiModelDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const name = String(fields["name"] ?? resource.displayName);
  const description = String(fields["description"] ?? "");
  return {
    title: name,
    subtitle: "Workers AI Model",
    // Models have no lifecycle state — they're always available to call.
    status: { kind: "status-dot", status: "healthy", label: "Available" },
    sections: [
      {
        kind: "section",
        title: "Model Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Model", value: name, copyable: true },
              { key: "Task", value: String(fields["task"] ?? "Text Generation") },
              ...(description ? [{ key: "Description", value: description }] : []),
            ],
          },
        ],
      },
    ],
    // Host auto-renders a "Playground" tab whenever chatPanel is set. No
    // disabledReason — Workers AI models are always callable.
    chatPanel: {
      tabLabel: "Playground",
      subtitle: `Chat with ${name}`,
      greeting:
        "Hi! This is the Workers AI model playground — send a prompt to see how it responds. The full conversation history is sent on each turn.",
      inputPlaceholder: "Send a message…",
    },
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

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

export function renderPagesProjectDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const latestStatus = String(fields["latestDeploymentStatus"] ?? "");

  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Project Info",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Name", value: String(fields["name"] ?? ""), copyable: true },
            { key: "Subdomain", value: String(fields["subdomain"] ?? ""), copyable: true },
            ...(fields["productionBranch"]
              ? [{ key: "Production Branch", value: String(fields["productionBranch"]) }]
              : []),
            ...(fields["framework"]
              ? [{ key: "Framework", value: String(fields["framework"]) }]
              : []),
            ...(fields["domains"]
              ? [{ key: "Custom Domains", value: String(fields["domains"]) }]
              : []),
          ],
        },
      ],
    },
  ];

  if (latestStatus || fields["latestDeploymentUrl"]) {
    sections.push({
      kind: "section",
      title: "Latest Deployment",
      children: [
        {
          kind: "key-value-list",
          items: [
            ...(latestStatus ? [{ key: "Status", value: latestStatus }] : []),
            ...(fields["latestDeploymentUrl"]
              ? [{ key: "URL", value: String(fields["latestDeploymentUrl"]), copyable: true }]
              : []),
          ],
        },
      ],
    });
  }

  return {
    title: resource.displayName,
    subtitle: "Pages Project",
    status: latestStatus
      ? { kind: "status-dot", status: deploymentStatus(latestStatus), label: latestStatus }
      : { kind: "status-dot", status: "info" },
    sections,
    headerActions: [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ...(fields["subdomain"]
        ? [
            {
              kind: "action" as const,
              label: "Open Site",
              action: {
                type: "open-url" as const,
                url: `https://${String(fields["subdomain"])}`,
              },
            },
          ]
        : []),
    ],
  };
}

export function renderPagesDeploymentDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const status = String(fields["status"] ?? "");
  return {
    title: `${String(fields["environment"] ?? "")} Deployment`,
    subtitle: String(fields["branch"] ?? ""),
    status: { kind: "status-dot", status: deploymentStatus(status), label: status },
    sections: [
      {
        kind: "section",
        title: "Deployment Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Environment", value: String(fields["environment"] ?? "") },
              { key: "Status", value: status },
              ...(fields["branch"] ? [{ key: "Branch", value: String(fields["branch"]) }] : []),
              ...(fields["commitHash"]
                ? [
                    {
                      key: "Commit",
                      value: String(fields["commitHash"]).slice(0, 8),
                      copyable: true,
                    },
                  ]
                : []),
              ...(fields["commitMessage"]
                ? [{ key: "Message", value: String(fields["commitMessage"]) }]
                : []),
              ...(fields["url"]
                ? [{ key: "URL", value: String(fields["url"]), copyable: true }]
                : []),
              ...(fields["createdOn"]
                ? [{ key: "Created", value: String(fields["createdOn"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ...(fields["url"]
        ? [
            {
              kind: "action" as const,
              label: "Open",
              action: { type: "open-url" as const, url: String(fields["url"]) },
            },
          ]
        : []),
    ],
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

export function renderTunnelDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const status = String(fields["status"] ?? "");
  return {
    title: resource.displayName,
    subtitle: "Cloudflare Tunnel",
    status: { kind: "status-dot", status: tunnelStatus(status), label: status || "Unknown" },
    sections: [
      {
        kind: "section",
        title: "Tunnel Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(fields["name"] ?? ""), copyable: true },
              { key: "Tunnel ID", value: resource.externalId ?? "", copyable: true },
              { key: "Status", value: status },
              ...(fields["tunnelType"]
                ? [{ key: "Type", value: String(fields["tunnelType"]) }]
                : []),
              ...(fields["remoteConfig"] !== undefined
                ? [{ key: "Remote Config", value: fields["remoteConfig"] ? "Yes" : "No" }]
                : []),
              ...(fields["connectionsCount"] !== undefined
                ? [{ key: "Active Connections", value: String(fields["connectionsCount"]) }]
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
  };
}

export function renderSSLCertificateDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const status = String(fields["status"] ?? "");
  return {
    title: resource.displayName,
    subtitle: "SSL/TLS Certificate",
    status: { kind: "status-dot", status: sslStatus(status), label: status },
    sections: [
      {
        kind: "section",
        title: "Certificate Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Hosts", value: String(fields["hosts"] ?? ""), copyable: true },
              { key: "Status", value: status },
              ...(fields["issuer"] ? [{ key: "Issuer", value: String(fields["issuer"]) }] : []),
              ...(fields["type"] ? [{ key: "Type", value: String(fields["type"]) }] : []),
              ...(fields["expiresOn"]
                ? [{ key: "Expires", value: String(fields["expiresOn"]) }]
                : []),
              ...(fields["zoneName"] ? [{ key: "Zone", value: String(fields["zoneName"]) }] : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderPageRuleDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const status = String(fields["status"] ?? "");
  return {
    title: resource.displayName,
    subtitle: "Page Rule",
    status: {
      kind: "status-dot",
      status: status === "active" ? "healthy" : "info",
      label: status,
    },
    sections: [
      {
        kind: "section",
        title: "Page Rule Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "URL Pattern", value: String(fields["targets"] ?? ""), copyable: true },
              { key: "Status", value: status },
              ...(fields["actions"] ? [{ key: "Actions", value: String(fields["actions"]) }] : []),
              ...(fields["priority"] !== undefined
                ? [{ key: "Priority", value: String(fields["priority"]) }]
                : []),
              ...(fields["createdOn"]
                ? [{ key: "Created", value: String(fields["createdOn"]) }]
                : []),
              ...(fields["modifiedOn"]
                ? [{ key: "Modified", value: String(fields["modifiedOn"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderFirewallRuleDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const enabled = Boolean(fields["enabled"]);
  return {
    title: String(fields["description"] || resource.displayName),
    subtitle: "WAF Custom Rule",
    status: {
      kind: "status-dot",
      status: enabled ? "healthy" : "info",
      label: enabled ? "Active" : "Disabled",
    },
    sections: [
      {
        kind: "section",
        title: "Rule Details",
        children: [
          {
            kind: "badge",
            label: String(fields["action"] ?? ""),
            color:
              fields["action"] === "block"
                ? "red"
                : fields["action"] === "challenge"
                  ? "yellow"
                  : "blue",
          },
          {
            kind: "key-value-list",
            items: [
              { key: "Action", value: String(fields["action"] ?? "") },
              { key: "Expression", value: String(fields["expression"] ?? ""), copyable: true },
              { key: "Enabled", value: enabled ? "Yes" : "No" },
              ...(fields["priority"] !== undefined
                ? [{ key: "Priority", value: String(fields["priority"]) }]
                : []),
              ...(fields["description"]
                ? [{ key: "Description", value: String(fields["description"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderAccessApplicationDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  return {
    title: resource.displayName,
    subtitle: "Zero Trust Access Application",
    status: { kind: "status-dot", status: "healthy", label: "Active" },
    sections: [
      {
        kind: "section",
        title: "Application Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(fields["name"] ?? ""), copyable: true },
              { key: "Domain", value: String(fields["domain"] ?? ""), copyable: true },
              ...(fields["type"] ? [{ key: "Type", value: String(fields["type"]) }] : []),
              ...(fields["sessionDuration"]
                ? [{ key: "Session Duration", value: String(fields["sessionDuration"]) }]
                : []),
              ...(fields["createdAt"]
                ? [{ key: "Created", value: String(fields["createdAt"]) }]
                : []),
              ...(fields["updatedAt"]
                ? [{ key: "Updated", value: String(fields["updatedAt"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderLoadBalancerDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const enabled = Boolean(fields["enabled"]);
  return {
    title: resource.displayName,
    subtitle: "Load Balancer",
    status: {
      kind: "status-dot",
      status: enabled ? "healthy" : "error",
      label: enabled ? "Enabled" : "Disabled",
    },
    sections: [
      {
        kind: "section",
        title: "Load Balancer Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(fields["name"] ?? ""), copyable: true },
              { key: "Enabled", value: enabled ? "Yes" : "No" },
              ...(fields["proxied"] !== undefined
                ? [{ key: "Proxied", value: fields["proxied"] ? "Yes" : "No" }]
                : []),
              ...(fields["steeringPolicy"]
                ? [{ key: "Steering Policy", value: String(fields["steeringPolicy"]) }]
                : []),
              ...(fields["fallbackPool"]
                ? [{ key: "Fallback Pool", value: String(fields["fallbackPool"]) }]
                : []),
              ...(fields["defaultPools"]
                ? [{ key: "Default Pools", value: String(fields["defaultPools"]) }]
                : []),
              ...(fields["ttl"] !== undefined
                ? [{ key: "TTL", value: formatDnsTtl(Number(fields["ttl"])) }]
                : []),
              ...(fields["createdOn"]
                ? [{ key: "Created", value: String(fields["createdOn"]) }]
                : []),
              ...(fields["modifiedOn"]
                ? [{ key: "Modified", value: String(fields["modifiedOn"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderWorkerRouteDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  return {
    title: resource.displayName,
    subtitle: "Worker Route",
    status: {
      kind: "status-dot",
      status: fields["script"] ? "healthy" : "info",
      label: fields["script"] ? "Routed" : "No Script",
    },
    sections: [
      {
        kind: "section",
        title: "Route Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Pattern", value: String(fields["pattern"] ?? ""), copyable: true },
              ...(fields["script"]
                ? [{ key: "Worker Script", value: String(fields["script"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderGenericDetail(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
): DetailViewSchema {
  const fields = resource.fields;
  return {
    title: resource.displayName,
    subtitle: resource.resourceTypeId,
    status: { kind: "status-dot", status: "info" },
    sections: [
      {
        kind: "section",
        title: "Details",
        children: [
          {
            kind: "key-value-list",
            items: labeledFieldItems(fields, resourceTypes, resource.resourceTypeId),
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderCustomHostnameDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const status = String(fields["status"] ?? "");
  return {
    title: String(fields["hostname"] ?? resource.displayName),
    subtitle: "Custom Hostname (SSL for SaaS)",
    status: {
      kind: "status-dot",
      status: status === "active" ? "healthy" : status === "pending" ? "provisioning" : "info",
      label: status,
    },
    sections: [
      {
        kind: "section",
        title: "Hostname Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Hostname", value: String(fields["hostname"] ?? ""), copyable: true },
              { key: "Status", value: status },
              ...(fields["sslStatus"]
                ? [{ key: "SSL Status", value: String(fields["sslStatus"]) }]
                : []),
              ...(fields["sslMethod"]
                ? [{ key: "SSL Method", value: String(fields["sslMethod"]) }]
                : []),
              ...(fields["sslType"] ? [{ key: "SSL Type", value: String(fields["sslType"]) }] : []),
              ...(fields["createdAt"]
                ? [{ key: "Created", value: String(fields["createdAt"]) }]
                : []),
            ],
          },
        ],
      },
    ],
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

export function renderEmailRoutingRuleDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const enabled = Boolean(fields["enabled"]);
  return {
    title: String(fields["name"] || resource.displayName),
    subtitle: "Email Routing Rule",
    status: {
      kind: "status-dot",
      status: enabled ? "healthy" : "info",
      label: enabled ? "Enabled" : "Disabled",
    },
    sections: [
      {
        kind: "section",
        title: "Rule Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Enabled", value: enabled ? "Yes" : "No" },
              ...(fields["matchers"]
                ? [{ key: "Matchers", value: String(fields["matchers"]) }]
                : []),
              ...(fields["actions"] ? [{ key: "Actions", value: String(fields["actions"]) }] : []),
              ...(fields["priority"] !== undefined
                ? [{ key: "Priority", value: String(fields["priority"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderWaitingRoomDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const suspended = Boolean(fields["suspended"]);
  return {
    title: resource.displayName,
    subtitle: "Waiting Room",
    status: {
      kind: "status-dot",
      status: suspended ? "error" : "healthy",
      label: suspended ? "Suspended" : "Active",
    },
    sections: [
      {
        kind: "section",
        title: "Configuration",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(fields["name"] ?? ""), copyable: true },
              { key: "Host", value: String(fields["host"] ?? ""), copyable: true },
              ...(fields["path"] ? [{ key: "Path", value: String(fields["path"]) }] : []),
              ...(fields["totalActiveUsers"] !== undefined
                ? [{ key: "Max Active Users", value: String(fields["totalActiveUsers"]) }]
                : []),
              ...(fields["newUsersPerMinute"] !== undefined
                ? [{ key: "New Users/Minute", value: String(fields["newUsersPerMinute"]) }]
                : []),
              ...(fields["queueingMethod"]
                ? [{ key: "Queueing Method", value: String(fields["queueingMethod"]) }]
                : []),
              ...(fields["sessionDuration"] !== undefined
                ? [{ key: "Session Duration", value: `${String(fields["sessionDuration"])} min` }]
                : []),
              { key: "Suspended", value: suspended ? "Yes" : "No" },
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderAccessPolicyDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const decision = String(fields["decision"] ?? "");
  return {
    title: resource.displayName,
    subtitle: "Access Policy",
    status: {
      kind: "status-dot",
      status: decision === "allow" ? "healthy" : decision === "deny" ? "error" : "info",
      label: decision,
    },
    sections: [
      {
        kind: "section",
        title: "Policy Details",
        children: [
          {
            kind: "badge",
            label: decision,
            color:
              decision === "allow"
                ? "green"
                : decision === "deny"
                  ? "red"
                  : decision === "bypass"
                    ? "yellow"
                    : "gray",
          },
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(fields["name"] ?? "") },
              { key: "Decision", value: decision },
              ...(fields["precedence"] !== undefined
                ? [{ key: "Precedence", value: String(fields["precedence"]) }]
                : []),
              ...(fields["includeRules"]
                ? [{ key: "Include", value: String(fields["includeRules"]) }]
                : []),
              ...(fields["excludeRules"]
                ? [{ key: "Exclude", value: String(fields["excludeRules"]) }]
                : []),
              ...(fields["requireRules"]
                ? [{ key: "Require", value: String(fields["requireRules"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderSpectrumApplicationDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  return {
    title: String(fields["dns"] ?? resource.displayName),
    subtitle: `Spectrum · ${String(fields["protocol"] ?? "")}`,
    status: { kind: "status-dot", status: "healthy", label: String(fields["protocol"] ?? "") },
    sections: [
      {
        kind: "section",
        title: "Application Details",
        children: [
          { kind: "badge", label: String(fields["protocol"] ?? ""), color: "blue" },
          {
            kind: "key-value-list",
            items: [
              ...(fields["dns"]
                ? [{ key: "DNS Name", value: String(fields["dns"]), copyable: true }]
                : []),
              { key: "Protocol", value: String(fields["protocol"] ?? "") },
              ...(fields["originDirect"]
                ? [{ key: "Origin Direct", value: String(fields["originDirect"]) }]
                : []),
              ...(fields["originDns"]
                ? [{ key: "Origin DNS", value: String(fields["originDns"]) }]
                : []),
              ...(fields["originPort"]
                ? [{ key: "Origin Port", value: String(fields["originPort"]) }]
                : []),
              ...(fields["tls"] ? [{ key: "TLS", value: String(fields["tls"]) }] : []),
              ...(fields["proxyProtocol"]
                ? [{ key: "Proxy Protocol", value: String(fields["proxyProtocol"]) }]
                : []),
              ...(fields["ipFirewall"] !== undefined
                ? [{ key: "IP Firewall", value: fields["ipFirewall"] ? "Enabled" : "Disabled" }]
                : []),
              ...(fields["createdOn"]
                ? [{ key: "Created", value: String(fields["createdOn"]) }]
                : []),
              ...(fields["modifiedOn"]
                ? [{ key: "Modified", value: String(fields["modifiedOn"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderLogpushJobDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const enabled = Boolean(fields["enabled"]);
  const lastError = String(fields["lastError"] ?? "");
  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Job Details",
      children: [
        { kind: "badge", label: String(fields["dataset"] ?? ""), color: "blue" },
        {
          kind: "key-value-list",
          items: [
            ...(fields["name"] ? [{ key: "Name", value: String(fields["name"]) }] : []),
            { key: "Dataset", value: String(fields["dataset"] ?? "") },
            { key: "Enabled", value: enabled ? "Yes" : "No" },
            ...(fields["destinationType"]
              ? [{ key: "Destination", value: String(fields["destinationType"]) }]
              : []),
            ...(fields["frequency"]
              ? [{ key: "Frequency", value: String(fields["frequency"]) }]
              : []),
            ...(fields["logpullOptions"]
              ? [{ key: "Logpull Options", value: String(fields["logpullOptions"]) }]
              : []),
            ...(fields["lastComplete"]
              ? [{ key: "Last Complete", value: String(fields["lastComplete"]) }]
              : []),
          ],
        },
      ],
    },
  ];
  if (lastError) {
    sections.push({
      kind: "section",
      title: "Last Error",
      children: [{ kind: "text", content: lastError, variant: "mono" }],
    });
  }
  return {
    title: String(fields["name"] || fields["dataset"] || resource.displayName),
    subtitle: "Logpush Job",
    status: {
      kind: "status-dot",
      status: !enabled ? "info" : lastError ? "error" : "healthy",
      label: !enabled ? "Disabled" : lastError ? "Error" : "Active",
    },
    sections,
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}
