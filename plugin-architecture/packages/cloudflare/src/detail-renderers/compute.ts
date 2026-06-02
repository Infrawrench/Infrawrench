import type {
  ResourceInstance,
  DetailViewSchema,
  SectionNode,
  TableRow,
  ResourceTypeDefinition,
} from "@infrawrench/plugin-base";
import { labeledFieldItems } from "@infrawrench/plugin-base";
import { deploymentStatus } from "./status.js";

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
    // Surfaces a curated, labeled settings *form* (not a raw JSON editor) via the
    // settingsEditor capability. The host calls getManifest → { settings:
    // SettingDescriptor[] } to populate it and sends changed rows back through
    // applyManifest (worker script settings, workers.dev subdomain, cron triggers).
    settingsEditor: {
      tabLabel: "Settings",
      description: "Configure this Worker's runtime settings, subdomain, and triggers.",
    },
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

/**
 * Durable Object namespace detail. Renders the namespace metadata, a browser of
 * the live instances (paged in by `enrichDetail` and stashed in resolvedOutputs
 * as `__instances__`), and the Metrics tab. Cloudflare exposes no public API to
 * read or write an instance's storage from outside a Worker — only the instance
 * list — so this is a read-only browser, not a storage editor.
 */
export function renderDurableObjectNamespaceDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const sqlite = Boolean(fields["useSqlite"]);

  let instances: Array<{ id: string; hasStoredData: boolean }> = [];
  const raw = resource.resolvedOutputs["__instances__"];
  if (typeof raw === "string" && raw) {
    try {
      instances = JSON.parse(raw) as Array<{ id: string; hasStoredData: boolean }>;
    } catch {
      instances = [];
    }
  }
  const truncated = resource.resolvedOutputs["__instancesTruncated__"] === "true";

  const instanceRows: TableRow[] = instances.map((inst) => ({
    cells: {
      id: inst.id,
      stored: inst.hasStoredData ? "Yes" : "No",
    },
  }));

  const instanceSection: SectionNode = {
    kind: "section",
    title: `Instances${instances.length ? ` (${instances.length}${truncated ? "+" : ""})` : ""}`,
    children:
      instanceRows.length > 0
        ? [
            {
              kind: "table",
              columns: [
                { key: "id", label: "Object ID", mono: true, width: "wide" },
                { key: "stored", label: "Stored Data", width: "narrow" },
              ],
              rows: instanceRows,
            },
            ...(truncated
              ? [
                  {
                    kind: "text" as const,
                    content: `Showing the first ${instances.length} instances; this namespace has more.`,
                    variant: "muted" as const,
                  },
                ]
              : []),
            {
              kind: "text" as const,
              content:
                "Cloudflare exposes no public API to read or edit a Durable Object's storage from outside a Worker, so instances are read-only here. Use the dashboard's Data Studio (SQLite-backed objects) to inspect storage contents.",
              variant: "muted" as const,
            },
          ]
        : [
            {
              kind: "text" as const,
              content: "No live instances found in this namespace.",
              variant: "muted" as const,
            },
          ],
  };

  return {
    title: resource.displayName,
    subtitle: "Durable Object Namespace",
    status: { kind: "status-dot", status: "healthy", label: "Deployed" },
    sections: [
      {
        kind: "section",
        title: "Namespace Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(fields["name"] ?? ""), copyable: true },
              { key: "Namespace ID", value: resource.externalId ?? "", copyable: true },
              ...(fields["class"] ? [{ key: "Class", value: String(fields["class"]) }] : []),
              ...(fields["script"]
                ? [{ key: "Worker Script", value: String(fields["script"]) }]
                : []),
              { key: "Storage Backend", value: sqlite ? "SQLite" : "Key-value" },
            ],
          },
        ],
      },
      instanceSection,
    ],
    metricsCapability: {},
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

/** Sensible default model for the gateway playground — a small, fast, always-on
 * Workers AI instruct model when present, otherwise the first catalog entry. */
function pickDefaultModel(models: string[]): string {
  const FALLBACK = "@cf/meta/llama-3.1-8b-instruct";
  if (models.length === 0) return FALLBACK;
  return (
    models.find((m) => m.includes("llama-3.1-8b-instruct")) ??
    models.find((m) => m.toLowerCase().includes("llama")) ??
    models[0]!
  );
}

/**
 * AI Gateway detail view. Mirrors the Cloudflare dashboard's gateway page: the
 * settings, the gateway endpoint URL, a copyable code example, a metrics tab,
 * and a Playground that streams Workers AI chat *through* the gateway (so the
 * gateway's own logs/analytics fill in). The Cloudflare account id and the
 * Workers AI model catalog are stashed on `resolvedOutputs` by `enrichDetail`.
 */
export function renderAiGatewayDetail(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
): DetailViewSchema {
  const fields = resource.fields;
  const gatewayId = resource.externalId ?? String(fields["id"] ?? "");
  const cfAccountId = String(resource.resolvedOutputs["__cfAccountId__"] ?? "");

  let models: string[] = [];
  const rawModels = resource.resolvedOutputs["__models__"];
  if (typeof rawModels === "string" && rawModels) {
    try {
      models = JSON.parse(rawModels) as string[];
    } catch {
      models = [];
    }
  }
  const defaultModel = pickDefaultModel(models);

  // `…/compat` is the OpenAI-SDK base URL (the SDK appends /chat/completions).
  const acct = cfAccountId || "{account-id}";
  const baseUrl = `https://gateway.ai.cloudflare.com/v1/${acct}/${gatewayId}`;
  const compatUrl = `${baseUrl}/compat`;

  const codeExample = [
    `import OpenAI from "openai";`,
    ``,
    `const client = new OpenAI({`,
    `  apiKey: process.env.OPENAI_API_KEY,`,
    `  baseURL: "${compatUrl}",`,
    `});`,
    ``,
    `const response = await client.chat.completions.create({`,
    `  model: "openai/gpt-5",`,
    `  messages: [{ role: "user", content: "Hello, world!" }],`,
    `});`,
  ].join("\n");

  const sections: SectionNode[] = [
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
    {
      kind: "section",
      title: "Gateway endpoint",
      children: [
        {
          kind: "text",
          content:
            "Send requests to this endpoint with any HTTP client. For OpenAI SDKs, use the `/compat` base URL — the SDK appends the path.",
          variant: "muted",
        },
        { kind: "text", content: compatUrl, variant: "mono", copyable: true },
        ...(cfAccountId
          ? []
          : [
              {
                kind: "text" as const,
                content:
                  "Account id couldn't be loaded, so `{account-id}` is a placeholder above — your token needs zone/account read access to resolve it.",
                variant: "muted" as const,
              },
            ]),
      ],
    },
    {
      kind: "section",
      title: "Code example",
      children: [{ kind: "text", content: codeExample, variant: "mono", copyable: true }],
    },
  ];

  return {
    title: resource.displayName,
    subtitle: "AI Gateway",
    status: { kind: "status-dot", status: "info" },
    sections,
    metricsCapability: {},
    chatPanel: {
      tabLabel: "Playground",
      subtitle: "Workers AI, routed through this gateway",
      greeting:
        "Chat with a Workers AI model through this gateway. Requests authenticate with your Cloudflare token (no provider keys needed) and show up in the gateway's logs and analytics. Pick a model above.",
      inputPlaceholder: "Send a message…",
      models: models.length > 0 ? models : [defaultModel],
      defaultModel,
      modelLabel: "Workers AI model",
    },
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}
