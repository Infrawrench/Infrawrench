import type {
  ResourceInstance,
  DetailViewSchema,
  SectionNode,
  TableRow,
  ResourceTypeDefinition,
  ActionNode,
  ResourceStatus,
  DetailViewTab,
} from "@infrawrench/plugin-base";
import { labeledFieldItems } from "@infrawrench/plugin-base";
import type {
  WorkerObservabilityState,
  WorkerTraceSummary,
} from "../clients/worker-observability.js";
import {
  actionsForStatus,
  type WorkflowInstanceAction,
  type WorkflowInstanceSummary,
} from "../clients/workflow-client.js";

/**
 * Cloudflare's GraphQL analytics look back 24h when the host asks without a
 * range (`analyticsWindow` in ../metric-series.ts). Renderers that state the
 * capability themselves have to state the same window, or their chart's
 * time-range label contradicts the data under it.
 */
const CLOUDFLARE_METRICS = { defaultTimeRangeMs: 24 * 3_600_000 };

function parseJson<T>(raw: string | undefined): T | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

const onOffLabel = (b: boolean): string => (b ? "On" : "Off");
const pct = (n: number | null): string => `${Math.round((n ?? 1) * 1000) / 10}%`;

/** Workers Logs / Traces switches, with a pointer to the Settings tab when off. */
function workerObservabilitySection(state: WorkerObservabilityState | null): SectionNode | null {
  if (!state) return null;
  return {
    kind: "section",
    title: "Observability",
    children: [
      {
        kind: "key-value-list",
        items: [
          { key: "Workers Logs", value: onOffLabel(state.logsEnabled) },
          ...(state.logsEnabled
            ? [
                { key: "Invocation logs", value: onOffLabel(state.invocationLogs) },
                {
                  key: "Logs sampling",
                  value: pct(state.logsSamplingRate ?? state.headSamplingRate),
                },
              ]
            : []),
          { key: "Workers Traces", value: onOffLabel(state.tracesEnabled) },
          ...(state.tracesEnabled
            ? [{ key: "Trace sampling", value: pct(state.tracesSamplingRate) }]
            : []),
        ],
      },
      ...(state.logsEnabled
        ? []
        : [
            {
              kind: "text" as const,
              content:
                "Workers Logs is off, so the Logs tab and log charts stay empty. Turn on Observability in the Settings tab.",
              variant: "muted" as const,
            },
          ]),
    ],
  };
}

function formatTraceDuration(msValue: number): string {
  if (!Number.isFinite(msValue)) return "";
  return msValue >= 1000 ? `${(msValue / 1000).toFixed(2)} s` : `${Math.round(msValue)} ms`;
}

/** "Traces" tab: the latest trace summaries from the telemetry `traces` view. */
function workerTracesTab(
  resource: ResourceInstance,
  state: WorkerObservabilityState | null,
): DetailViewTab | null {
  if (!state) return null;
  const traces = parseJson<WorkerTraceSummary[]>(resource.resolvedOutputs["__traces__"]);
  const error = resource.resolvedOutputs["__tracesError__"];
  const muted = (content: string): SectionNode["children"][number] => ({
    kind: "text",
    content,
    variant: "muted",
  });

  let body: SectionNode["children"];
  if (!state.tracesEnabled) {
    body = [
      muted(
        "Workers Traces is off for this Worker. Turn on Traces under Observability in the Settings tab to record the handler, fetch calls and binding calls for each sampled request.",
      ),
    ];
  } else if (error) {
    body = [muted(`Couldn't load traces: ${error}`)];
  } else if (!traces || traces.length === 0) {
    body = [muted("No traces in the last 24 hours.")];
  } else {
    const rows: TableRow[] = traces.map((t) => ({
      cells: {
        started: Number.isFinite(t.traceStartMs) ? new Date(t.traceStartMs).toISOString() : "",
        root: t.rootSpanName || t.rootTransactionName || "",
        spans: String(t.spans ?? ""),
        duration: formatTraceDuration(t.traceDurationMs),
        services: (t.service ?? []).join(", "),
        errors: (t.errors ?? []).join("; "),
        traceId: t.traceId,
      },
    }));
    body = [
      {
        kind: "table",
        columns: [
          { key: "started", label: "Started" },
          { key: "root", label: "Root span", width: "wide" },
          { key: "spans", label: "Spans", width: "narrow" },
          { key: "duration", label: "Duration", width: "narrow" },
          { key: "services", label: "Services" },
          { key: "errors", label: "Errors" },
          { key: "traceId", label: "Trace ID", mono: true },
        ],
        rows,
      },
    ];
  }
  return {
    id: "worker-traces",
    label: "Traces",
    sections: [
      {
        kind: "section",
        title: `Recent Traces${traces && traces.length > 0 ? ` (${traces.length})` : ""}`,
        children: body,
      },
    ],
  };
}

export function renderWorkerDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const observability = parseJson<WorkerObservabilityState>(
    resource.resolvedOutputs["__observability__"],
  );
  const observabilitySection = workerObservabilitySection(observability);
  const tracesTab = workerTracesTab(resource, observability);
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
      ...(observabilitySection ? [observabilitySection] : []),
    ],
    // Declared unconditionally (not only when observability is on) because
    // log-workspace discovery renders stored rows without enrichDetail; a
    // Worker with logging off gets an explanation from getLogs instead.
    logs: { defaultTailLines: 200 },
    ...(tracesTab ? { customTabs: [tracesTab] } : {}),
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
    // Models have no lifecycle state: they're always available to call.
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
    // disabledReason: Workers AI models are always callable.
    chatPanel: {
      tabLabel: "Playground",
      subtitle: `Chat with ${name}`,
      greeting:
        "Hi! This is the Workers AI model playground. Send a prompt to see how it responds. The full conversation history is sent on each turn.",
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
 * read or write an instance's storage from outside a Worker (only the instance
 * list) so this is a read-only browser, not a storage editor.
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
                "Durable Object storage can't be read or edited from outside a Worker, so instances are read-only here. Use the dashboard's Data Studio (SQLite-backed objects) to inspect storage.",
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
    metricsCapability: CLOUDFLARE_METRICS,
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

/**
 * Curated text-generation models for the gateway playground when the live
 * catalog can't be fetched (e.g. the token lacks Workers AI:Read, which 403s
 * the models endpoint). Kept short and to widely-available `@cf/...` models so
 * the dropdown still offers a real choice. The first entry is the default.
 */
const FALLBACK_MODELS = [
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/google/gemma-3-12b-it",
  "@cf/qwen/qwen2.5-coder-32b-instruct",
];

/** Sensible default model for the gateway playground: a small, fast, always-on
 * Workers AI instruct model when present, otherwise the first catalog entry. */
function pickDefaultModel(models: string[]): string {
  if (models.length === 0) return FALLBACK_MODELS[0]!;
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
            "Send requests to this endpoint with any HTTP client. For OpenAI SDKs, use the `/compat` base URL; the SDK appends the path.",
          variant: "muted",
        },
        { kind: "text", content: compatUrl, variant: "mono", copyable: true },
        ...(cfAccountId
          ? []
          : [
              {
                kind: "text" as const,
                content:
                  "Account id couldn't be loaded, so `{account-id}` is a placeholder above. Your token needs zone/account read access.",
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

  // An authenticated gateway rejects requests that don't carry a
  // `cf-aig-authorization` gateway token (which we don't hold) so the
  // playground can't reach it. Disable the input with a clear reason rather
  // than surfacing a raw 401.
  const authenticated = fields["authentication"] === true;

  return {
    title: resource.displayName,
    subtitle: "AI Gateway",
    status: { kind: "status-dot", status: "info" },
    sections,
    metricsCapability: CLOUDFLARE_METRICS,
    chatPanel: {
      tabLabel: "Playground",
      subtitle: "Workers AI, routed through this gateway",
      greeting:
        "Chat with a Workers AI model through this gateway. Requests use your Cloudflare token (no provider keys) and appear in the gateway's logs and analytics. Pick a model above.",
      inputPlaceholder: "Send a message…",
      models: models.length > 0 ? models : FALLBACK_MODELS,
      defaultModel,
      modelLabel: "Workers AI model",
      ...(authenticated
        ? {
            disabledReason:
              "This gateway requires a gateway token the playground doesn't hold. Turn off authentication (Edit AI Gateway) to chat here, or call it from your code with a cf-aig-authorization header.",
          }
        : {}),
    },
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

const INSTANCE_ACTION_LABELS: Record<WorkflowInstanceAction, string> = {
  pause: "Pause",
  resume: "Resume",
  terminate: "Terminate",
  restart: "Restart",
};

const INSTANCE_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  errored: "Errored",
  terminated: "Terminated",
  complete: "Complete",
  waitingForPause: "Pausing",
  waiting: "Waiting",
  rollingBack: "Rolling back",
};

function instanceActionNode(instanceId: string, action: WorkflowInstanceAction): ActionNode {
  const label = INSTANCE_ACTION_LABELS[action];
  const confirm: Partial<Record<WorkflowInstanceAction, string>> = {
    terminate: `Terminate instance "${instanceId}"? It stops at its current step and cannot be resumed.`,
    restart: `Restart instance "${instanceId}" from the beginning with its original params?`,
  };
  return {
    kind: "action",
    label,
    ...(action === "terminate" ? { variant: "danger" as const } : {}),
    action: {
      type: "plugin-action",
      // The instance id is everything after the first colon; ids the
      // user supplies at creation can't be assumed colon-free.
      actionId: `instance-${action}:${instanceId}`,
      ...(confirm[action] ? { confirmMessage: confirm[action] } : {}),
      successMessage: `${label} requested for instance "${instanceId}".`,
    },
  };
}

/**
 * Workflow detail: instance counts by state, cron schedules, and the most
 * recent instances (enrichDetail stashes them in `__instances__`) with
 * per-row lifecycle controls. "Trigger Instance" starts a run with no params.
 */
export function renderWorkflowDetail(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
): DetailViewSchema {
  const fields = resource.fields;
  const n = (k: string): number => Number(fields[k] ?? 0) || 0;

  let instances: WorkflowInstanceSummary[] = [];
  const raw = resource.resolvedOutputs["__instances__"];
  const loaded = typeof raw === "string" && raw.length > 0;
  if (loaded) {
    try {
      instances = JSON.parse(raw) as WorkflowInstanceSummary[];
    } catch {
      instances = [];
    }
  }
  const truncated = resource.resolvedOutputs["__instancesTruncated__"] === "true";

  const status: { status: ResourceStatus; label: string } =
    n("errored") > 0
      ? { status: "degraded", label: `${n("errored")} errored` }
      : n("running") + n("queued") + n("waiting") > 0
        ? { status: "healthy", label: "Running" }
        : { status: "info", label: "Idle" };

  const rows: TableRow[] = instances.map((inst) => {
    const actions = actionsForStatus(inst.status);
    const cells: TableRow["cells"] = {
      id: inst.id,
      status: INSTANCE_STATUS_LABELS[inst.status] ?? inst.status,
      trigger: inst.triggerSource || "",
      started: inst.startedOn || inst.createdOn,
      ended: inst.endedOn,
    };
    for (const a of ["pause", "resume", "terminate", "restart"] as const) {
      cells[a] = actions.includes(a) ? instanceActionNode(inst.id, a) : "";
    }
    return { cells };
  });

  const instanceSection: SectionNode = {
    kind: "section",
    title: `Recent Instances${rows.length ? ` (${rows.length}${truncated ? "+" : ""})` : ""}`,
    children:
      rows.length > 0
        ? [
            {
              kind: "table",
              columns: [
                { key: "id", label: "Instance ID", mono: true, width: "wide" },
                { key: "status", label: "Status", width: "narrow" },
                { key: "trigger", label: "Trigger", width: "narrow" },
                { key: "started", label: "Started" },
                { key: "ended", label: "Ended" },
                { key: "pause", label: "", width: "narrow" },
                { key: "resume", label: "", width: "narrow" },
                { key: "terminate", label: "", width: "narrow" },
                { key: "restart", label: "", width: "narrow" },
              ],
              rows,
              emphasizeFirstColumn: true,
            },
          ]
        : [
            {
              kind: "text",
              content: loaded
                ? "No instances yet. Trigger one from the header, from a Worker binding, or on a cron schedule."
                : "Couldn't load this workflow's instances.",
              variant: "muted",
            },
          ],
  };

  return {
    title: resource.displayName,
    subtitle: "Workflow",
    status: { kind: "status-dot", ...status },
    sections: [
      {
        kind: "section",
        title: "Workflow Details",
        children: [
          {
            kind: "key-value-list",
            items: labeledFieldItems(fields, resourceTypes, resource.resourceTypeId),
          },
        ],
      },
      instanceSection,
    ],
    headerActions: [
      {
        kind: "action",
        label: "Trigger Instance",
        action: {
          type: "plugin-action",
          actionId: "trigger-instance",
          confirmMessage: `Start a new instance of "${resource.displayName}" with no params?`,
          successMessage: "Instance queued.",
        },
      },
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    ],
  };
}
