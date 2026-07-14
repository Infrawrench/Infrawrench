/**
 * Detail-view renderers for DigitalOcean resources, extracted from client.ts.
 * All functions are pure over the resource instance; `renderDetail` in
 * DigitalOceanClient dispatches into them.
 */
import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
  ImageOption,
  ResourceInstance,
  SectionNode,
  SizeOption,
} from "@infrawrench/plugin-base";
import {
  formatDnsTtl,
  renderDnsRecordDetail as sharedRenderDnsRecordDetail,
} from "@infrawrench/plugin-base";
import { kafkaAclFields } from "./resources/managed-database.js";
import { SPACES_REGIONS } from "./constants.js";

/**
 * Best-effort JSON-array parse for catalog data stuffed into resolvedOutputs
 * by enrichDetail. Returns [] on any error so the picker degrades gracefully.
 */
export function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * Build DigitalOcean's embeddable chatbot `<script>` snippet for a public
 * agent. Mirrors what the DO control panel offers under "Embed". Only valid
 * for public agents with a chatbot identifier — the widget script is served
 * from the agent's own deployment host.
 */
function buildAgentEmbedScript(
  deploymentUrl: string,
  chatbotId: string,
  chatbot: {
    name?: string;
    primary_color?: string;
    secondary_color?: string;
    button_background_color?: string;
    starting_message?: string;
    logo?: string;
  },
  agentUuid: string,
): string {
  let origin = deploymentUrl;
  try {
    origin = new URL(deploymentUrl).origin;
  } catch {
    /* fall back to the raw url */
  }
  const attr = (k: string, v: string): string => `  data-${k}="${v.replace(/"/g, "&quot;")}"`;
  const lines = [
    "<script",
    `  src="${origin}/static/chatbot/widget.js"`,
    attr("agent-id", agentUuid),
    attr("chatbot-id", chatbotId),
    attr("name", `${chatbot.name ?? "Agent"} Chatbot`),
    attr("primary-color", chatbot.primary_color ?? "#031B4E"),
    attr("secondary-color", chatbot.secondary_color ?? "#E5E8ED"),
    attr("button-background-color", chatbot.button_background_color ?? "#0061EB"),
    ...(chatbot.starting_message ? [attr("starting-message", chatbot.starting_message)] : []),
    attr("logo", chatbot.logo || "/static/chatbot/icons/default-agent.svg"),
    "  async>",
    "</script>",
  ];
  return lines.join("\n");
}

/**
 * Inference-router detail page: a "Routing Policies" table (task → models →
 * selection preference) and a "Fallback Models" section. Both are read from
 * the router's `config`, stashed as `__policies__` / `__fallbackModels__`
 * during listGenAiModelRouters.
 */
export function applyGenAiModelRouterDetail(
  detail: DetailViewSchema,
  resource: ResourceInstance,
): void {
  const outputs = resource.resolvedOutputs ?? {};
  interface PolicyModel {
    id?: string;
    name?: string;
  }
  interface Policy {
    task?: string;
    prefer?: string;
    models?: PolicyModel[];
  }
  interface TaskPreset {
    task_slug?: string;
    name?: string;
    models?: string[];
    prefer?: string;
  }
  const policies = parseJsonArray<Policy>(outputs["__policies__"]);
  const fallback = parseJsonArray<PolicyModel>(outputs["__fallbackModels__"]);
  const taskPresets = parseJsonArray<TaskPreset>(outputs["__taskPresets__"]);
  const modelOptions = parseJsonArray<{ id?: string; label?: string }>(
    outputs["__routerModelOptions__"],
  );

  const modelLabel = (m: PolicyModel): string => {
    const name = String(m.name ?? "").trim();
    const id = String(m.id ?? "").trim();
    if (name && id) return `${name}`;
    return name || id || "—";
  };
  const preferLabel = (p: string): string => {
    switch (p) {
      case "cheapest":
        return "Cheapest";
      case "fastest":
        return "Fastest";
      case "none":
      case "":
        return "Balanced";
      default:
        return p;
    }
  };

  // Pickers shared by the Add and per-row Edit policy forms.
  const taskOptions = taskPresets
    .filter((t) => t.task_slug)
    .map((t) => ({ id: String(t.task_slug), label: String(t.name ?? t.task_slug) }));
  const preferOptions = [
    { id: "none", label: "Balanced (default)" },
    { id: "cheapest", label: "Cheapest" },
    { id: "fastest", label: "Fastest" },
  ];
  const modelPolicyOptions = modelOptions
    .filter((o) => o.id)
    .map((o) => ({ id: String(o.id), label: String(o.label ?? o.id) }));
  const canEditPolicies = taskOptions.length > 0;

  // Build the field set for the add/edit policy prompt. `originalTask` is a
  // hidden marker the handler uses to replace the right policy on edit.
  const policyFields = (
    preset: { task?: string; prefer?: string; modelIds?: string[] } = {},
  ): CreateFieldConfig[] => [
    {
      key: "originalTask",
      label: "",
      kind: "text",
      required: false,
      hidden: true,
      defaultValue: preset.task ?? "",
    },
    {
      key: "task",
      label: "Task",
      kind: "select",
      required: true,
      options: taskOptions,
      ...((preset.task ?? taskOptions[0]?.id)
        ? { defaultValue: preset.task ?? taskOptions[0]!.id }
        : {}),
      description: "Which kind of request this policy routes.",
    },
    {
      key: "prefer",
      label: "Selection preference",
      kind: "select",
      required: true,
      options: preferOptions,
      defaultValue: preset.prefer && preset.prefer !== "" ? preset.prefer : "none",
    },
    {
      key: "modelIds",
      label: "Models",
      kind: "policy-picker",
      required: false,
      policies: modelPolicyOptions.map((o) => ({
        id: o.id,
        label: o.label,
        category: "Router-eligible models",
      })),
      ...(preset.modelIds && preset.modelIds.length > 0
        ? { defaultValue: JSON.stringify(preset.modelIds) }
        : {}),
      description:
        "Models this task may route to. Leave empty to use the task's recommended default models.",
    },
  ];

  detail.headerActions = [
    { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    {
      kind: "action",
      label: "+ Add policy",
      variant: "ghost",
      action: {
        type: "prompt-nosql-command",
        command: "save-router-policy",
        title: "Add routing policy",
        ...(canEditPolicies
          ? {
              description:
                "Route a class of requests to specific models with a cost/latency preference.",
            }
          : {
              description: "No router task presets are available on this account.",
              descriptionVariant: "error" as const,
              blocked: true,
            }),
        fields: canEditPolicies ? policyFields() : [],
      },
    },
  ];

  if (policies.length > 0) {
    detail.sections.push({
      kind: "section",
      title: "Routing Policies",
      children: [
        {
          kind: "table",
          columns: [
            { key: "task", label: "Task" },
            { key: "models", label: "Models" },
            { key: "prefer", label: "Prefers", width: "narrow" },
            { key: "edit", label: "", width: "narrow" },
            { key: "remove", label: "", width: "narrow" },
          ],
          rows: policies.map((p) => {
            const taskSlug = String(p.task ?? "");
            const modelIds = (p.models ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
            const editAction: ActionNode | string = canEditPolicies
              ? {
                  kind: "action",
                  label: "Edit",
                  variant: "ghost",
                  action: {
                    type: "prompt-nosql-command",
                    command: "save-router-policy",
                    title: `Edit policy: ${taskSlug || "default"}`,
                    submitLabel: "Save",
                    fields: policyFields({
                      task: taskSlug,
                      prefer: String(p.prefer ?? ""),
                      modelIds,
                    }),
                  },
                }
              : "";
            return {
              cells: {
                task: taskSlug || "Default",
                models: (p.models ?? []).map(modelLabel).join(", ") || "—",
                prefer: preferLabel(String(p.prefer ?? "")),
                edit: editAction,
                remove: {
                  kind: "action",
                  label: "Remove",
                  variant: "ghost",
                  action: {
                    type: "prompt-nosql-command",
                    command: "remove-router-policy",
                    title: "Remove routing policy",
                    description: `Remove the "${taskSlug || "default"}" policy? Requests for this task fall through to the fallback models.`,
                    submitLabel: "Remove",
                    danger: true,
                    fields: [
                      {
                        key: "task",
                        label: "Task",
                        kind: "text",
                        required: true,
                        hidden: true,
                        defaultValue: taskSlug,
                      },
                    ],
                  },
                } as ActionNode,
              },
            };
          }),
        },
      ],
    });
  } else {
    detail.sections.push({
      kind: "section",
      title: "Routing Policies",
      children: [
        {
          kind: "text",
          variant: "muted",
          content:
            "No per-task routing policies configured. Requests fall through to the fallback models — use “+ Add policy” to route specific tasks to specific models.",
        },
      ],
    });
  }

  detail.sections.push({
    kind: "section",
    title: "Fallback Models",
    children: [
      fallback.length > 0
        ? {
            kind: "table",
            columns: [
              { key: "model", label: "Model" },
              { key: "id", label: "ID", mono: true },
            ],
            rows: fallback.map((m) => ({
              cells: { model: modelLabel(m), id: String(m.id ?? "") },
            })),
          }
        : {
            kind: "text",
            variant: "muted",
            content: "No fallback models set.",
          },
    ],
  });
}

/**
 * Adds the events log and, for engines whose built-in user has no password
 * (mongo/redis/opensearch/kafka), a "Make connection user" header action.
 * The "DB Users" section is rendered automatically by the host as a
 * child-resource group thanks to `db-user.parentTypeId === "managed-database"`.
 */
export function applyManagedDatabaseDetail(
  detail: DetailViewSchema,
  resource: ResourceInstance,
): void {
  const status = String(resource.fields["status"] ?? "");
  const online = status === "online";
  const engine = String(resource.fields["engine"] ?? "");
  // Mongo/Redis/OpenSearch/Kafka never hand back the default user's password,
  // so peer-pane connections depend on a user minted (+ captured) here.
  // pg/mysql get their password inline, so they don't need the button.
  const needsMintButton =
    online && ["mongodb", "redis", "valkey", "opensearch", "kafka"].includes(engine);

  // Events log — DO doesn't expose process-level logs, but the cluster's
  // event stream covers backups, maintenance, scale events, etc. That's
  // useful as a "what's been happening to my cluster" feed. MongoDB
  // clusters reject the events endpoint (422 "operation is not supported
  // for this cluster type"), so skip the Logs tab for them.
  if (engine !== "mongodb") {
    detail.logs = { defaultTailLines: 200 };
  }

  if (needsMintButton) {
    detail.headerActions = [
      ...(detail.headerActions ?? []),
      {
        kind: "action",
        label: "+ Make connection user",
        variant: "ghost",
        action: {
          type: "prompt-nosql-command",
          command: "make-db-user",
          title: "Create connection user",
          description:
            "DigitalOcean reveals a database user's credential exactly once, at creation. " +
            "Infrawrench creates the user, captures that credential, and stores it locally so " +
            "this cluster's peer-pane connection works.",
          submitLabel: "Create user",
          fields: [
            {
              key: "name",
              label: "Username",
              kind: "text",
              required: true,
              defaultValue: `infrawrench-${Math.random().toString(36).slice(2, 8)}`,
              description: "Letters, digits, and `_-` only. Must be unique within the cluster.",
            },
            // Kafka requires an ACL on the user; surface topic + permission so
            // it's editable, defaulting to full access on every topic.
            ...(engine === "kafka" ? kafkaAclFields() : []),
          ],
        },
      },
    ];
  }
}

/** A db-user's detail view is mostly its connection-credential summary. */
export function applyDatabaseUserDetail(
  detail: DetailViewSchema,
  resource: ResourceInstance,
): void {
  detail.subtitle = `Database user · ${String(resource.fields["role"] ?? "user")}`;
  detail.sections.push({
    kind: "section",
    title: "Credential",
    children: [
      {
        kind: "text",
        variant: "muted",
        content:
          "The password DO returned at create time is stored locally and used to fill in the " +
          "cluster's connection string. DO doesn't expose passwords for users it didn't create " +
          "via this flow, so pre-existing users (including `doadmin`) show no stored password.",
      },
    ],
  });
}

/**
 * Agent detail page: visibility toggle in the header, attached-resource
 * sections (knowledge bases, function routes, child agents) populated by
 * `enrichGenAiAgent`, and "+ Attach"/"+ Add"/"+ Route" header actions.
 */
export function applyGenAiAgentDetail(detail: DetailViewSchema, resource: ResourceInstance): void {
  const fields = resource.fields;
  const outputs = resource.resolvedOutputs ?? {};

  // Wire the Playground chat tab. Disabled while the deployment is still
  // provisioning — the agents.do-ai.run hostname only resolves once status
  // flips to running.
  const status = String(fields["status"] ?? "").toUpperCase();
  const deploymentReady = status === "STATUS_RUNNING" || status === "RUNNING";
  const modelLabel = String(fields["modelName"] ?? fields["modelRouterName"] ?? "");
  detail.chatPanel = {
    tabLabel: "Playground",
    subtitle: modelLabel ? `Chat with this agent · ${modelLabel}` : "Chat with this agent",
    greeting:
      "Hi! This is the deployed agent — try out a prompt to see how it responds. The full conversation history is sent on each turn.",
    inputPlaceholder: "Send a message…",
    ...(deploymentReady
      ? {}
      : {
          disabledReason:
            "The agent is still deploying. Wait for the status to flip to Running and reload this tab.",
        }),
  };
  const visibility = String(fields["deploymentVisibility"] ?? "");
  const isPublic = visibility === "VISIBILITY_PUBLIC";

  interface AttachedKb {
    uuid?: string;
    name?: string;
  }
  interface AttachedFn {
    uuid?: string;
    function_name?: string;
    description?: string;
    faas_name?: string;
    faas_namespace?: string;
  }
  interface AttachedChild {
    uuid?: string;
    name?: string;
    route_name?: string;
    if_case?: string;
  }
  interface PickerAgent {
    uuid?: string;
    name?: string;
  }
  interface PickerKb {
    uuid?: string;
    name?: string;
  }
  interface FunctionNamespace {
    namespace?: string;
    label?: string;
    region?: string;
  }
  const attachedKbs = parseJsonArray<AttachedKb>(outputs["__attachedKbs__"]);
  const functions = parseJsonArray<AttachedFn>(outputs["__functions__"]);
  const childAgents = parseJsonArray<AttachedChild>(outputs["__childAgents__"]);
  const allAgents = parseJsonArray<PickerAgent>(outputs["__allAgents__"]);
  const allKbs = parseJsonArray<PickerKb>(outputs["__allKbs__"]);
  const functionNamespaces = parseJsonArray<FunctionNamespace>(outputs["__functionNamespaces__"]);
  const namespaceOptions = functionNamespaces
    .filter((n) => n.namespace)
    .map((n) => ({
      id: String(n.namespace),
      label: n.label ? `${n.label} (${n.region ?? "?"})` : String(n.namespace),
    }));

  // Knowledge bases not already attached — used as the picker options
  // for the "Attach knowledge base" prompt.
  const attachedKbUuids = new Set(attachedKbs.map((k) => String(k.uuid ?? "")));
  const unattachedKbs = allKbs.filter((k) => !attachedKbUuids.has(String(k.uuid ?? "")));
  const attachedChildUuids = new Set(childAgents.map((c) => String(c.uuid ?? "")));
  const unattachedAgents = allAgents.filter((a) => !attachedChildUuids.has(String(a.uuid ?? "")));

  // Header — Refresh, visibility toggle, attach buttons. Visibility flips
  // between Public and Private; the label tracks the *current* state so
  // the button always shows the action that will happen.
  detail.headerActions = [
    { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    {
      kind: "action",
      label: isPublic ? "Make Private" : "Make Public",
      variant: "ghost",
      action: {
        type: "plugin-action",
        actionId: isPublic ? "make-private" : "make-public",
        confirmMessage: isPublic
          ? "Make this agent's endpoint private? Existing public chatbot links will stop working."
          : "Make this agent's endpoint public? Anyone with the URL will be able to chat with it.",
        successMessage: `Endpoint is now ${isPublic ? "Private" : "Public"}.`,
      },
    },
    {
      kind: "action",
      label: "+ Attach knowledge base",
      variant: "ghost",
      action: {
        type: "prompt-nosql-command",
        command: "attach-knowledge-base",
        title: "Attach knowledge base",
        description:
          unattachedKbs.length === 0
            ? "No knowledge bases available to attach. Create one in the Knowledge Bases section first, or drag an existing one onto this agent."
            : "Pick a knowledge base to attach to this agent.",
        ...(unattachedKbs.length === 0
          ? { descriptionVariant: "error" as const, blocked: true }
          : {}),
        fields: [
          {
            key: "knowledgeBaseUuid",
            label: "Knowledge Base",
            kind: "select",
            required: true,
            options: unattachedKbs.map((k) => ({
              id: String(k.uuid ?? ""),
              label: String(k.name ?? k.uuid ?? ""),
            })),
          },
        ],
      },
    },
    {
      kind: "action",
      label: "+ Add function route",
      variant: "ghost",
      action: {
        type: "prompt-nosql-command",
        command: "attach-function",
        title: "Add function route",
        fields: [
          { key: "functionName", label: "Function name", kind: "text", required: true },
          { key: "description", label: "Description", kind: "text", required: false },
          {
            key: "faasName",
            label: "FaaS function name",
            kind: "text",
            required: true,
            description: "DigitalOcean Functions name (e.g. `weather/lookup`).",
          },
          namespaceOptions.length > 0
            ? {
                key: "faasNamespace",
                label: "FaaS namespace",
                kind: "select" as const,
                required: true,
                options: namespaceOptions,
                ...(namespaceOptions[0] ? { defaultValue: namespaceOptions[0].id } : {}),
                description: "Pick one of this account's DigitalOcean Functions namespaces.",
              }
            : {
                key: "faasNamespace",
                label: "FaaS namespace",
                kind: "text" as const,
                required: true,
                description:
                  "Functions namespace id (fn-…). No namespaces found on this account — create one in DigitalOcean Functions first.",
              },
          {
            key: "inputSchema",
            label: "Input JSON Schema",
            kind: "json-schema",
            required: false,
            description: "Describe the function's arguments as named properties.",
          },
          {
            key: "outputSchema",
            label: "Output JSON Schema",
            kind: "json-schema",
            required: false,
            description: "Describe the function's return value as named properties.",
          },
        ],
      },
    },
    {
      kind: "action",
      label: "+ Route to child agent",
      variant: "ghost",
      action: {
        type: "prompt-nosql-command",
        command: "attach-child-agent",
        title: "Attach child agent",
        description:
          unattachedAgents.length === 0
            ? "No other agents to route to. Create another agent first."
            : "Route this agent's requests to a child agent under specific conditions.",
        ...(unattachedAgents.length === 0
          ? { descriptionVariant: "error" as const, blocked: true }
          : {}),
        fields: [
          {
            key: "childAgentUuid",
            label: "Child agent",
            kind: "select",
            required: true,
            options: unattachedAgents.map((a) => ({
              id: String(a.uuid ?? ""),
              label: String(a.name ?? a.uuid ?? ""),
            })),
          },
          {
            key: "routeName",
            label: "Route name",
            kind: "text",
            required: false,
            description: "Display label for this route — visible to the agent during routing.",
          },
          {
            key: "ifCase",
            label: "If case",
            kind: "text",
            required: false,
            description:
              "Optional condition string the parent agent uses when deciding to route here.",
          },
        ],
      },
    },
  ];

  // Endpoint section — copyable deployment URL + the OpenAI-compatible
  // base URL. Both are `copyable` so the host renders a copy button.
  const deploymentUrl = String(outputs["deploymentUrl"] ?? fields["deploymentUrl"] ?? "");
  if (deploymentUrl) {
    let baseUrl = deploymentUrl;
    try {
      baseUrl = `${new URL(deploymentUrl).origin}/api/v1`;
    } catch {
      baseUrl = `${deploymentUrl.replace(/\/+$/, "")}/api/v1`;
    }
    detail.sections.push({
      kind: "section",
      title: "Endpoint",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Deployment URL", value: deploymentUrl, copyable: true },
            { key: "OpenAI base URL", value: baseUrl, copyable: true },
          ],
        },
      ],
    });
  }

  // Embed section — DigitalOcean's public chatbot <script> snippet. Only
  // valid once the agent's endpoint is public (private agents need an
  // access key the public widget can't supply) and a chatbot identifier
  // exists. Rendered as a copyable mono block.
  const chatbotId = String(outputs["__chatbotId__"] ?? "");
  if (isPublic && chatbotId && deploymentUrl) {
    const chatbot = (() => {
      try {
        return JSON.parse(String(outputs["__chatbot__"] ?? "{}")) as Record<string, string>;
      } catch {
        return {};
      }
    })();
    const agentUuid = resource.externalId ?? resource.id.split(":").pop() ?? "";
    const script = buildAgentEmbedScript(deploymentUrl, chatbotId, chatbot, agentUuid);
    detail.sections.push({
      kind: "section",
      title: "Embed (public chatbot)",
      children: [
        {
          kind: "text",
          variant: "muted",
          content:
            "Drop this snippet into your site's HTML to embed the chatbot widget. Works because the endpoint is public.",
        },
        { kind: "text", variant: "mono", content: script, copyable: true },
      ],
    });
  } else if (chatbotId && deploymentUrl) {
    // Has a chatbot but the endpoint is private — tell the user how to
    // enable the embed rather than silently hiding it.
    detail.sections.push({
      kind: "section",
      title: "Embed (public chatbot)",
      children: [
        {
          kind: "text",
          variant: "muted",
          content:
            "The embeddable chatbot widget is only available for public endpoints. Use the Make Public header action, then reload to copy the snippet.",
        },
      ],
    });
  }

  // Knowledge bases section — one row per attached KB with an inline
  // Detach button. The detach button reuses prompt-nosql-command so we
  // can confirm before the DELETE.
  if (attachedKbs.length > 0) {
    detail.sections.push({
      kind: "section",
      title: "Knowledge Bases",
      children: [
        {
          kind: "table",
          columns: [
            { key: "name", label: "Name" },
            { key: "uuid", label: "UUID", mono: true },
            { key: "action", label: "", width: "narrow" },
          ],
          rows: attachedKbs.map((k) => ({
            cells: {
              name: String(k.name ?? k.uuid ?? ""),
              uuid: String(k.uuid ?? ""),
              action: {
                kind: "action",
                label: "Detach",
                variant: "ghost",
                action: {
                  type: "prompt-nosql-command",
                  command: "detach-knowledge-base",
                  title: "Detach knowledge base",
                  description: `Detach "${k.name ?? k.uuid}" from this agent? The knowledge base itself isn't deleted.`,
                  submitLabel: "Detach",
                  danger: true,
                  fields: [
                    {
                      key: "knowledgeBaseUuid",
                      label: "Knowledge Base UUID",
                      kind: "text",
                      required: true,
                      hidden: true,
                      defaultValue: String(k.uuid ?? ""),
                    },
                  ],
                },
              } as ActionNode,
            },
          })),
        },
      ],
    });
  } else {
    detail.sections.push({
      kind: "section",
      title: "Knowledge Bases",
      children: [
        {
          kind: "text",
          variant: "muted",
          content:
            "No knowledge bases attached. Drag a knowledge base from the sidebar onto this agent, or use the '+ Attach knowledge base' header action.",
        },
      ],
    });
  }

  // Function routes section.
  if (functions.length > 0) {
    detail.sections.push({
      kind: "section",
      title: "Function Routes",
      children: [
        {
          kind: "table",
          columns: [
            { key: "name", label: "Function" },
            { key: "target", label: "FaaS target" },
            { key: "description", label: "Description" },
            { key: "action", label: "", width: "narrow" },
          ],
          rows: functions.map((f) => ({
            cells: {
              name: String(f.function_name ?? f.uuid ?? ""),
              target: `${String(f.faas_namespace ?? "")}/${String(f.faas_name ?? "")}`,
              description: String(f.description ?? ""),
              action: {
                kind: "action",
                label: "Detach",
                variant: "ghost",
                action: {
                  type: "prompt-nosql-command",
                  command: "detach-function",
                  title: "Detach function route",
                  description: `Remove function route "${f.function_name ?? f.uuid}" from this agent?`,
                  submitLabel: "Remove",
                  danger: true,
                  fields: [
                    {
                      key: "functionUuid",
                      label: "Function UUID",
                      kind: "text",
                      required: true,
                      hidden: true,
                      defaultValue: String(f.uuid ?? ""),
                    },
                  ],
                },
              } as ActionNode,
            },
          })),
        },
      ],
    });
  }

  // Child agents (agent routes) section.
  if (childAgents.length > 0) {
    detail.sections.push({
      kind: "section",
      title: "Agent Routes",
      children: [
        {
          kind: "table",
          columns: [
            { key: "route", label: "Route" },
            { key: "agent", label: "Child agent" },
            { key: "if", label: "If case" },
            { key: "action", label: "", width: "narrow" },
          ],
          rows: childAgents.map((c) => ({
            cells: {
              route: String(c.route_name ?? c.name ?? c.uuid ?? ""),
              agent: String(c.name ?? c.uuid ?? ""),
              if: String(c.if_case ?? ""),
              action: {
                kind: "action",
                label: "Detach",
                variant: "ghost",
                action: {
                  type: "prompt-nosql-command",
                  command: "detach-child-agent",
                  title: "Detach child agent",
                  description: `Remove route to "${c.name ?? c.uuid}"?`,
                  submitLabel: "Detach",
                  danger: true,
                  fields: [
                    {
                      key: "childAgentUuid",
                      label: "Child Agent UUID",
                      kind: "text",
                      required: true,
                      hidden: true,
                      defaultValue: String(c.uuid ?? ""),
                    },
                  ],
                },
              } as ActionNode,
            },
          })),
        },
      ],
    });
  }
}

/**
 * Knowledge base detail page: data-source management (add Spaces/web
 * sources, per-source reindex/remove), an indexing-job history table, and
 * the hybrid retrieval endpoint. The data-source + job lists are populated
 * by `enrichGenAiKnowledgeBase`; actions flow through `executeNoSqlCommand`.
 */
export function applyGenAiKnowledgeBaseDetail(
  detail: DetailViewSchema,
  resource: ResourceInstance,
): void {
  const outputs = resource.resolvedOutputs ?? {};

  interface DataSourceRow {
    uuid?: string;
    type?: string;
    summary?: string;
    status?: string;
    created_at?: string;
  }
  interface JobRow {
    uuid?: string;
    status?: string;
    phase?: string;
    total_datasources?: number;
    completed_datasources?: number;
    tokens?: string;
    created_at?: string;
    finished_at?: string;
  }
  interface BucketOpt {
    name?: string;
    region?: string;
  }
  const dataSources = parseJsonArray<DataSourceRow>(outputs["__dataSources__"]);
  const jobs = parseJsonArray<JobRow>(outputs["__indexingJobs__"]);
  const buckets = parseJsonArray<BucketOpt>(outputs["__spacesBuckets__"]);

  const formatIndexStatus = (raw: string): string => {
    switch (raw) {
      case "INDEX_JOB_STATUS_COMPLETED":
        return "Completed";
      case "INDEX_JOB_STATUS_IN_PROGRESS":
        return "Indexing";
      case "INDEX_JOB_STATUS_PENDING":
        return "Pending";
      case "INDEX_JOB_STATUS_FAILED":
        return "Failed";
      case "INDEX_JOB_STATUS_CANCELLED":
        return "Cancelled";
      case "INDEX_JOB_STATUS_PARTIAL":
        return "Partial";
      case "INDEX_JOB_STATUS_NO_CHANGES":
        return "No changes";
      default:
        return raw ? raw.replace(/^INDEX_JOB_STATUS_/, "") : "—";
    }
  };

  // The Spaces source can be picked from the account's actual buckets
  // (a resource selector — submits the bucket's `bucketRef` output =
  // `name|region`) or typed by hand. A `bucketSource` toggle gates the
  // two; default to "pick" when we discovered buckets during enrich,
  // otherwise "manual" (no Spaces keys → nothing to pick). Both pick and
  // manual fields are `required: false` because only one is visible at a
  // time; the handler validates the resolved bucket name + region.
  const hasBuckets = buckets.some((b) => b.name);
  const spacesSourceFields: CreateFieldConfig[] = [
    {
      key: "bucketSource",
      label: "Bucket source",
      kind: "select",
      required: true,
      defaultValue: hasBuckets ? "pick" : "manual",
      options: [
        { id: "pick", label: "Pick from my Spaces buckets" },
        { id: "manual", label: "Enter bucket name manually" },
      ],
      ...(hasBuckets
        ? {}
        : {
            description:
              "No Spaces buckets are listable — add Spaces API keys to this account to pick from a list.",
          }),
    },
    {
      // Resource selector — lists the account's Spaces buckets and submits
      // the chosen bucket's `bucketRef` output (`name|region`), which the
      // handler splits back apart.
      key: "spacesBucket",
      label: "Spaces bucket",
      kind: "resource-picker",
      required: false,
      associationSources: [
        { pluginId: "digitalocean", resourceTypeId: "spaces-bucket", outputKey: "bucketRef" },
      ],
      showWhen: { fieldKey: "bucketSource", fieldValue: "pick" },
    },
    {
      key: "spacesBucketName",
      label: "Spaces bucket name",
      kind: "text",
      required: false,
      description: "Name of the DigitalOcean Spaces bucket to index.",
      showWhen: { fieldKey: "bucketSource", fieldValue: "manual" },
    },
    {
      key: "spacesRegion",
      label: "Bucket region",
      kind: "region-picker",
      required: false,
      regions: SPACES_REGIONS.map((r) => ({ id: r, label: r })),
      ...(SPACES_REGIONS[0] ? { defaultValue: SPACES_REGIONS[0] } : {}),
      showWhen: { fieldKey: "bucketSource", fieldValue: "manual" },
    },
  ];

  detail.headerActions = [
    { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    {
      kind: "action",
      label: "Reindex all",
      variant: "ghost",
      action: {
        type: "prompt-nosql-command",
        command: "start-indexing",
        title: "Reindex all data sources",
        description:
          dataSources.length === 0
            ? "This knowledge base has no data sources yet. Add a Spaces bucket or web source first."
            : "Start an indexing job over every data source in this knowledge base. Existing embeddings stay queryable while the job runs.",
        ...(dataSources.length === 0
          ? { descriptionVariant: "error" as const, blocked: true }
          : { submitLabel: "Reindex all" }),
        fields: [],
      },
    },
    {
      kind: "action",
      label: "+ Add Spaces source",
      variant: "ghost",
      action: {
        type: "prompt-nosql-command",
        command: "add-spaces-source",
        title: "Add Spaces bucket data source",
        description:
          "Index files stored in a DigitalOcean Spaces bucket. Indexing starts automatically after the source is added.",
        submitLabel: "Add source",
        fields: [
          ...spacesSourceFields,
          {
            key: "itemPath",
            label: "Folder / object path",
            kind: "text",
            required: false,
            description: "Optional path within the bucket to scope indexing (e.g. `docs/`).",
          },
        ],
      },
    },
    {
      kind: "action",
      label: "+ Add web source",
      variant: "ghost",
      action: {
        type: "prompt-nosql-command",
        command: "add-web-source",
        title: "Add web crawler data source",
        description:
          "Crawl a public website and index its pages (up to 5,500). Indexing starts automatically after the source is added.",
        submitLabel: "Add source",
        fields: [
          {
            key: "baseUrl",
            label: "Base URL",
            kind: "text",
            required: true,
            description: "Seed URL to crawl, e.g. https://example.com/docs.",
          },
          {
            key: "crawlingOption",
            label: "Crawl scope",
            kind: "select",
            required: true,
            options: [
              { id: "SCOPED", label: "Scoped — only the base URL" },
              { id: "PATH", label: "Path — base URL + pages under its path" },
              { id: "DOMAIN", label: "Domain — base URL + same-domain pages" },
              { id: "SUBDOMAINS", label: "Subdomains — base URL + any subdomain" },
              { id: "SITEMAP", label: "Sitemap — URLs discovered in the sitemap" },
            ],
            defaultValue: "SCOPED",
          },
          {
            key: "embedMedia",
            label: "Index media (images, etc.)",
            kind: "select",
            required: false,
            options: [
              { id: "no", label: "No" },
              { id: "yes", label: "Yes" },
            ],
            defaultValue: "no",
          },
        ],
      },
    },
  ];

  // Retrieval endpoint — copyable so the user can wire it into their own
  // RAG client without hunting through DO's console.
  const retrieval = String(outputs["retrievalEndpoint"] ?? "");
  if (retrieval) {
    detail.sections.push({
      kind: "section",
      title: "Retrieval",
      children: [
        {
          kind: "key-value-list",
          items: [{ key: "Hybrid retrieval endpoint", value: retrieval, copyable: true }],
        },
      ],
    });
  }

  // Data sources table — per-row Reindex + Remove actions.
  if (dataSources.length > 0) {
    detail.sections.push({
      kind: "section",
      title: "Data Sources",
      children: [
        {
          kind: "table",
          columns: [
            { key: "type", label: "Type" },
            { key: "summary", label: "Source" },
            { key: "status", label: "Last index" },
            { key: "reindex", label: "", width: "narrow" },
            { key: "remove", label: "", width: "narrow" },
          ],
          rows: dataSources.map((d) => ({
            cells: {
              type: String(d.type ?? ""),
              summary: String(d.summary ?? ""),
              status: formatIndexStatus(String(d.status ?? "")),
              reindex: {
                kind: "action",
                label: "Reindex",
                variant: "ghost",
                action: {
                  type: "prompt-nosql-command",
                  command: "reindex-source",
                  title: "Reindex data source",
                  description: `Start an indexing job for "${d.summary ?? d.uuid}"?`,
                  submitLabel: "Reindex",
                  fields: [
                    {
                      key: "dataSourceUuid",
                      label: "Data Source UUID",
                      kind: "text",
                      required: true,
                      hidden: true,
                      defaultValue: String(d.uuid ?? ""),
                    },
                  ],
                },
              } as ActionNode,
              remove: {
                kind: "action",
                label: "Remove",
                variant: "ghost",
                action: {
                  type: "prompt-nosql-command",
                  command: "remove-data-source",
                  title: "Remove data source",
                  description: `Remove "${d.summary ?? d.uuid}" from this knowledge base? Its indexed embeddings will be deleted on the next index.`,
                  submitLabel: "Remove",
                  danger: true,
                  fields: [
                    {
                      key: "dataSourceUuid",
                      label: "Data Source UUID",
                      kind: "text",
                      required: true,
                      hidden: true,
                      defaultValue: String(d.uuid ?? ""),
                    },
                  ],
                },
              } as ActionNode,
            },
          })),
        },
      ],
    });
  } else {
    detail.sections.push({
      kind: "section",
      title: "Data Sources",
      children: [
        {
          kind: "text",
          variant: "muted",
          content:
            "No data sources yet. Use '+ Add Spaces source' or '+ Add web source' above to index content into this knowledge base.",
        },
      ],
    });
  }

  // Indexing jobs history — most-recent first. Includes a Cancel action for
  // jobs that are still pending/in-progress.
  if (jobs.length > 0) {
    detail.sections.push({
      kind: "section",
      title: "Indexing Jobs",
      children: [
        {
          kind: "table",
          columns: [
            { key: "status", label: "Status" },
            { key: "progress", label: "Sources" },
            { key: "tokens", label: "Tokens" },
            { key: "created", label: "Started" },
            { key: "action", label: "", width: "narrow" },
          ],
          rows: jobs.map((j) => {
            const status = String(j.status ?? "");
            const running =
              status === "INDEX_JOB_STATUS_IN_PROGRESS" || status === "INDEX_JOB_STATUS_PENDING";
            return {
              cells: {
                status: formatIndexStatus(status),
                progress: `${j.completed_datasources ?? 0}/${j.total_datasources ?? 0}`,
                tokens: String(j.tokens ?? ""),
                created: String(j.created_at ?? ""),
                action: running
                  ? ({
                      kind: "action",
                      label: "Cancel",
                      variant: "ghost",
                      action: {
                        type: "prompt-nosql-command",
                        command: "cancel-indexing",
                        title: "Cancel indexing job",
                        description: "Cancel this running indexing job?",
                        submitLabel: "Cancel job",
                        danger: true,
                        fields: [
                          {
                            key: "jobUuid",
                            label: "Job UUID",
                            kind: "text",
                            required: true,
                            hidden: true,
                            defaultValue: String(j.uuid ?? ""),
                          },
                        ],
                      },
                    } as ActionNode)
                  : "",
              },
            };
          }),
        },
      ],
    });
  }
}

/**
 * Add power/lifecycle action buttons + custom tabs (Actions, Backups,
 * Snapshots, Attached Volumes) to a droplet's detail view. State-aware:
 * surfaces "Power On" when the droplet is off and "Power Off" / "Shutdown"
 * when it's running so users don't see no-op buttons.
 */
export function applyDropletDetail(detail: DetailViewSchema, resource: ResourceInstance): void {
  const fields = resource.fields;
  const status = String(fields["status"] ?? "");
  const isRunning = status === "active";
  const isOff = status === "off";
  const features = String(fields["features"] ?? "").split(",");
  // Backups: prefer `nextBackupStart` / `backupPolicyPlan` over the
  // `features` array — DO sets the policy and the next-window timestamps
  // synchronously with the enable_backups action, but flips the
  // `features` entry on a separate (sometimes-delayed) tick. Using only
  // `features` meant the Enable Backups button stuck around after a
  // successful enable until the lag resolved.
  const backupsEnabled =
    features.includes("backups") ||
    !!String(fields["nextBackupStart"] ?? "") ||
    !!String(fields["backupPolicyPlan"] ?? "");
  // IPv6 is a one-way flip on DO — once enabled, the only signal is the
  // feature flag (and a public-v6 entry in `networks.v6`, which we surface
  // as the `ipv6` resolved output). We hide the Enable IPv6 button once
  // either is set so it doesn't look like the previous click was ignored.
  const ipv6Enabled = features.includes("ipv6") || !!String(resource.resolvedOutputs["ipv6"] ?? "");

  // Catalog data populated by enrichDetail. Falls back to empty arrays so
  // the modal still renders if enrichment failed (the picker will show no
  // options rather than the whole detail page crashing).
  const enrichedSizes = parseJsonArray<SizeOption>(resource.resolvedOutputs["__sizes__"]);
  const enrichedImages = parseJsonArray<ImageOption>(resource.resolvedOutputs["__images__"]);
  const currentSizeSlug = String(fields["size"] ?? "");
  const sizeOptions = enrichedSizes.filter((s) => s.id !== currentSizeSlug);

  // Backup/snapshot picker options: prefer the rich, human-readable list
  // populated by enrichDetail (one /v2/droplets/{id}/backups +
  // /v2/droplets/{id}/snapshots round-trip each). Falls back to the raw
  // id strings already in fields when enrichment failed or hasn't run
  // yet, so the picker still works on a slow/offline first paint.
  type RestoreOption = { id: string; label: string; category?: string };
  const enrichedRestore = parseJsonArray<RestoreOption>(
    resource.resolvedOutputs["__restoreOptions__"],
  );
  const backupIds = String(fields["backupIds"] ?? "")
    .split(",")
    .filter(Boolean);
  const snapshotIds = String(fields["snapshotIds"] ?? "")
    .split(",")
    .filter(Boolean);
  const restoreOptions: RestoreOption[] =
    enrichedRestore.length > 0
      ? enrichedRestore
      : [
          ...backupIds.map((id) => ({ id, label: `Backup ${id}`, category: "Backups" })),
          ...snapshotIds.map((id) => ({ id, label: `Snapshot ${id}`, category: "Snapshots" })),
        ];

  // Header lifecycle controls \u2014 keep this list short so the bar doesn't wrap.
  const headerActions: DetailViewSchema["headerActions"] = [
    { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
  ];
  if (isOff) {
    headerActions.push({
      kind: "action",
      label: "Power On",
      action: { type: "plugin-action", actionId: "power_on", successMessage: "Power-on queued." },
    });
  }
  if (isRunning) {
    headerActions.push(
      {
        kind: "action",
        label: "Reboot",
        variant: "ghost",
        action: {
          type: "plugin-action",
          actionId: "reboot",
          confirmMessage: "Reboot this droplet? The OS will be sent a soft reboot signal.",
          successMessage: "Reboot queued.",
        },
      },
      {
        kind: "action",
        label: "Shutdown",
        variant: "ghost",
        action: {
          type: "plugin-action",
          actionId: "shutdown",
          confirmMessage: "Cleanly shut down this droplet?",
          successMessage: "Shutdown queued.",
        },
      },
    );
  }
  headerActions.push({
    kind: "action",
    label: "Take Snapshot",
    variant: "ghost",
    action: {
      type: "plugin-action",
      actionId: "snapshot",
      confirmMessage:
        "Take a snapshot of this droplet now? Snapshots are auto-named with a timestamp and billed at the snapshot storage rate.",
      successMessage: "Snapshot queued.",
    },
  });
  detail.headerActions = headerActions;

  const lifecycleSections: SectionNode[] = [
    {
      kind: "section",
      title: "Power",
      children: [
        {
          kind: "grid",
          columns: 2,
          items: [
            {
              kind: "action",
              label: "Power Cycle (hard restart)",
              variant: "danger",
              action: {
                type: "plugin-action",
                actionId: "power_cycle",
                confirmMessage:
                  "Power-cycle this droplet? Equivalent to pulling the plug \u2014 running processes will not flush state.",
                successMessage: "Power-cycle queued.",
              },
            },
            {
              kind: "action",
              label: "Power Off (hard)",
              variant: "danger",
              action: {
                type: "plugin-action",
                actionId: "power_off",
                confirmMessage: "Force this droplet off without a clean OS shutdown?",
                successMessage: "Power-off queued.",
              },
            },
          ],
        },
      ],
    },
    {
      kind: "section",
      title: "Snapshot & Image",
      children: [
        {
          kind: "grid",
          columns: 2,
          items: [
            {
              kind: "action",
              label: "Take Named Snapshot\u2026",
              action: {
                type: "prompt-nosql-command",
                command: "snapshot-named",
                title: "Take a snapshot",
                description:
                  "Snapshots are billed at the snapshot storage rate while they exist. DigitalOcean recommends powering the droplet off first for a consistent snapshot.",
                fields: [
                  {
                    key: "name",
                    label: "Snapshot Name",
                    kind: "text",
                    required: true,
                    defaultValue: `${String(fields["name"] ?? "droplet")}-${new Date().toISOString().slice(0, 10)}`,
                  },
                ],
                submitLabel: "Take Snapshot",
              },
            },
            {
              kind: "action",
              label: "Rebuild from Image\u2026",
              variant: "danger",
              action: {
                type: "prompt-nosql-command",
                command: "rebuild",
                title: "Rebuild droplet",
                description:
                  "DESTRUCTIVE \u2014 rebuilds the droplet from an image. All data on the boot disk will be erased. The IP address is preserved.",
                fields: [
                  {
                    key: "image",
                    label: "Image",
                    kind: "image-picker",
                    required: true,
                    images: enrichedImages,
                  },
                ],
                submitLabel: "Rebuild",
                danger: true,
              },
            },
          ],
        },
      ],
    },
    {
      kind: "section",
      title: "Configuration",
      children: [
        {
          kind: "grid",
          columns: 2,
          items: [
            {
              kind: "action",
              label: "Rename\u2026",
              action: {
                type: "prompt-nosql-command",
                command: "rename",
                title: "Rename droplet",
                fields: [
                  {
                    key: "name",
                    label: "New Name",
                    kind: "text",
                    required: true,
                    defaultValue: String(fields["name"] ?? ""),
                  },
                ],
                submitLabel: "Rename",
              },
            },
            {
              kind: "action",
              label: "Resize\u2026",
              variant: "danger",
              action: {
                type: "prompt-nosql-command",
                command: "resize",
                title: "Resize droplet",
                description: `Current size: ${currentSizeSlug || "unknown"}. DigitalOcean powers the droplet down before resizing. Disk resizes are permanent (cannot scale down) \u2014 CPU/RAM-only resizes are reversible.`,
                fields: [
                  {
                    key: "size",
                    label: "New Size",
                    kind: "size-picker",
                    required: true,
                    sizes: sizeOptions,
                  },
                  {
                    key: "disk",
                    label: "Resize Disk Too?",
                    kind: "select",
                    required: true,
                    defaultValue: "false",
                    options: [
                      { id: "false", label: "No (CPU/RAM only \u2014 reversible)" },
                      { id: "true", label: "Yes (permanent \u2014 cannot scale down later)" },
                    ],
                  },
                ],
                submitLabel: "Resize",
                danger: true,
              },
            },
            ...(ipv6Enabled
              ? []
              : [
                  {
                    kind: "action" as const,
                    label: "Enable IPv6",
                    action: {
                      type: "plugin-action" as const,
                      actionId: "enable_ipv6",
                      confirmMessage: "Enable IPv6 networking on this droplet?",
                      successMessage: "IPv6 enabled.",
                    },
                  },
                ]),
            {
              kind: "action",
              label: "Reset Root Password",
              variant: "danger",
              action: {
                type: "plugin-action",
                actionId: "password_reset",
                confirmMessage:
                  "Reset the root password? DigitalOcean will email the new password to the account owner.",
                successMessage: "Password reset queued \u2014 check your DO account email.",
              },
            },
          ],
        },
      ],
    },
    {
      kind: "section",
      title: "Backups",
      children: [
        {
          kind: "grid",
          columns: 2,
          items: [
            backupsEnabled
              ? {
                  kind: "action",
                  label: "Disable Backups",
                  variant: "danger",
                  action: {
                    type: "plugin-action",
                    actionId: "disable_backups",
                    confirmMessage:
                      "Disable automatic backups? Existing backup images will be retained for the standard retention period.",
                    successMessage: "Backups disabled.",
                  },
                }
              : {
                  kind: "action",
                  label: "Enable Backups",
                  action: {
                    type: "plugin-action",
                    actionId: "enable_backups",
                    confirmMessage:
                      "Enable automatic backups? Adds ~20% to the droplet's hourly cost. Default schedule is weekly.",
                    successMessage: "Backups enabled.",
                  },
                },
            {
              kind: "action",
              label: "Change Backup Policy\u2026",
              action: {
                type: "prompt-nosql-command",
                command: "change-backup-policy",
                title: "Change backup policy",
                description:
                  "Daily backups have a 4-hour window; weekly backups also pick a weekday.",
                fields: [
                  {
                    key: "plan",
                    label: "Plan",
                    kind: "select",
                    required: true,
                    defaultValue: "weekly",
                    options: [
                      { id: "daily", label: "Daily" },
                      { id: "weekly", label: "Weekly" },
                    ],
                  },
                  {
                    key: "hour",
                    label: "Hour (UTC)",
                    kind: "select",
                    required: true,
                    defaultValue: "4",
                    options: [
                      { id: "0", label: "00:00" },
                      { id: "4", label: "04:00" },
                      { id: "8", label: "08:00" },
                      { id: "12", label: "12:00" },
                      { id: "16", label: "16:00" },
                      { id: "20", label: "20:00" },
                    ],
                  },
                  {
                    key: "weekday",
                    label: "Weekday",
                    kind: "select",
                    required: false,
                    defaultValue: "SUN",
                    options: [
                      { id: "SUN", label: "Sunday" },
                      { id: "MON", label: "Monday" },
                      { id: "TUE", label: "Tuesday" },
                      { id: "WED", label: "Wednesday" },
                      { id: "THU", label: "Thursday" },
                      { id: "FRI", label: "Friday" },
                      { id: "SAT", label: "Saturday" },
                    ],
                    showWhen: { fieldKey: "plan", fieldValue: "weekly" },
                  },
                ],
                submitLabel: "Save Policy",
              },
            },
            ...(restoreOptions.length > 0
              ? [
                  {
                    kind: "action" as const,
                    label: "Restore from Backup\u2026",
                    variant: "danger" as const,
                    action: {
                      type: "prompt-nosql-command" as const,
                      command: "restore",
                      title: "Restore from backup or snapshot",
                      description:
                        "DESTRUCTIVE \u2014 replaces the boot disk with the chosen image. The droplet is powered down during the restore.",
                      fields: [
                        {
                          key: "image",
                          label: "Backup or Snapshot",
                          kind: "select" as const,
                          required: true,
                          options: restoreOptions.map((r) => ({ id: r.id, label: r.label })),
                          description: `${
                            restoreOptions.filter((r) => r.category === "Backups").length
                          } backup(s) and ${
                            restoreOptions.filter((r) => r.category === "Snapshots").length
                          } snapshot(s) available. Newest first.`,
                        },
                      ],
                      submitLabel: "Restore",
                      danger: true,
                    },
                  },
                ]
              : [
                  // No restore points exist yet \u2014 surface the why and the
                  // next step inline rather than a dead-end modal.
                  {
                    kind: "text" as const,
                    variant: "muted" as const,
                    content: backupsEnabled
                      ? "No restore points yet \u2014 backups are enabled but the first one runs within ~24 hours of enabling. Use Take Named Snapshot above for an immediate restore point."
                      : "No restore points yet \u2014 enable backups below, or use Take Named Snapshot above to create one now.",
                  },
                ]),
          ],
        },
      ],
    },
  ];

  // Backups/Snapshots/Volumes render as key-value rows with restore/detach
  // actions inline. backupIds/snapshotIds were collected above for the
  // restore picker.
  const volumeIds = String(fields["volumeIds"] ?? "")
    .split(",")
    .filter(Boolean);

  const customTabs: DetailViewSchema["customTabs"] = [
    { id: "actions", label: "Actions", sections: lifecycleSections },
  ];

  // The restore-picker option labels are already formatted as
  // "[Backup] {name} \u2014 {date} \u2014 {size GB}" / "[Snapshot] {name} \u2014 \u2026".
  // Strip the leading "[Kind] " prefix for the pill label since the kind
  // is implied by the containing tab.
  const stripKindPrefix = (label: string): string => label.replace(/^\[[^\]]+\]\s*/, "");
  const backupPillOptions = restoreOptions.filter((r) => r.category === "Backups");
  const snapshotPillOptions = restoreOptions.filter((r) => r.category === "Snapshots");

  if (backupIds.length > 0) {
    const accountId = resource.accountId;
    // Backups aren't first-class resources (no detail page), so the pill
    // can't navigate. Pre-fill the Restore prompt with this backup id so
    // a click is one decision step instead of "open Restore \u2192 find this
    // id in the dropdown".
    const pills =
      backupPillOptions.length > 0
        ? backupPillOptions.map((b) => ({
            kind: "action" as const,
            label: stripKindPrefix(b.label),
            action: {
              type: "prompt-nosql-command" as const,
              command: "restore",
              title: "Restore from this backup",
              description:
                "DESTRUCTIVE \u2014 replaces the boot disk with this backup image. The droplet is powered down during the restore.",
              fields: [
                {
                  key: "image",
                  label: "Backup",
                  kind: "select" as const,
                  required: true,
                  options: [{ id: b.id, label: b.label }],
                  defaultValue: b.id,
                },
              ],
              submitLabel: "Restore",
              danger: true,
            },
          }))
        : // Enrichment hasn't loaded \u2014 fall back to raw-id pills with no
          // metadata so the user at least sees the count match.
          backupIds.map((id) => ({
            kind: "action" as const,
            label: `Backup ${id}`,
            action: {
              type: "prompt-nosql-command" as const,
              command: "restore",
              title: "Restore from this backup",
              description: "DESTRUCTIVE \u2014 replaces the boot disk with this backup image.",
              fields: [
                {
                  key: "image",
                  label: "Backup ID",
                  kind: "select" as const,
                  required: true,
                  options: [{ id, label: `Backup ${id}` }],
                  defaultValue: id,
                },
              ],
              submitLabel: "Restore",
              danger: true,
            },
          }));
    void accountId;
    customTabs.push({
      id: "backups",
      label: `Backups (${backupIds.length})`,
      sections: [
        {
          kind: "section",
          title: "Backup images",
          children: [
            { kind: "grid", columns: 2, items: pills },
            {
              kind: "text",
              variant: "muted",
              content:
                "Backups are kept for the retention window configured on the droplet. Click a backup above to restore from it.",
            },
          ],
        },
      ],
    });
  }

  if (snapshotIds.length > 0) {
    const accountId = resource.accountId;
    // Snapshots ARE resources \u2014 pills navigate to each snapshot's detail
    // page where rename / delete / create-droplet-from live.
    const pills =
      snapshotPillOptions.length > 0
        ? snapshotPillOptions.map((s) => ({
            kind: "action" as const,
            label: stripKindPrefix(s.label),
            action: {
              type: "navigate-to-resource" as const,
              pluginId: "digitalocean",
              resourceTypeId: "snapshot",
              resourceId: `${accountId}:snapshot:${s.id}`,
            },
          }))
        : snapshotIds.map((id) => ({
            kind: "action" as const,
            label: `Snapshot ${id}`,
            action: {
              type: "navigate-to-resource" as const,
              pluginId: "digitalocean",
              resourceTypeId: "snapshot",
              resourceId: `${accountId}:snapshot:${id}`,
            },
          }));
    customTabs.push({
      id: "snapshots",
      label: `Snapshots (${snapshotIds.length})`,
      sections: [
        {
          kind: "section",
          title: "Snapshots taken from this droplet",
          children: [
            { kind: "grid", columns: 2, items: pills },
            {
              kind: "text",
              variant: "muted",
              content:
                "Click a snapshot to open it \u2014 rename, delete, or create a new droplet from there.",
            },
          ],
        },
      ],
    });
  }

  if (volumeIds.length > 0) {
    const accountId = resource.accountId;
    customTabs.push({
      id: "volumes",
      label: `Volumes (${volumeIds.length})`,
      sections: [
        {
          kind: "section",
          title: "Attached block storage",
          children: [
            {
              kind: "table",
              columns: [
                { key: "id", label: "Volume ID", mono: true },
                { key: "open", label: "" },
              ],
              rows: volumeIds.map((id) => ({
                cells: {
                  id,
                  open: {
                    kind: "action",
                    label: "Open",
                    action: {
                      type: "navigate-to-resource",
                      pluginId: "digitalocean",
                      resourceTypeId: "volume",
                      resourceId: `${accountId}:volume:${id}`,
                    },
                  },
                },
              })),
            },
            {
              kind: "text",
              variant: "muted",
              content:
                "Detach from the volume's detail page. Volumes can only be attached to one droplet at a time and must be in the same region.",
            },
          ],
        },
      ],
    });
  }

  detail.customTabs = customTabs;
  detail.metricsCapability = { defaultTimeRangeMs: 60 * 60 * 1000 };
}

export function applyVolumeDetail(detail: DetailViewSchema, resource: ResourceInstance): void {
  const fields = resource.fields;
  const dropletIds = String(fields["dropletIds"] ?? "")
    .split(",")
    .filter(Boolean);
  const isAttached = dropletIds.length > 0;
  const headerActions: DetailViewSchema["headerActions"] = [
    { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    {
      kind: "action",
      label: "Take Snapshot\u2026",
      action: {
        type: "prompt-nosql-command",
        command: "volume-snapshot",
        title: "Snapshot volume",
        description:
          "Captures a point-in-time copy of this volume. Snapshots inherit the volume's region but can be used to create volumes in any DO region.",
        fields: [
          {
            key: "name",
            label: "Snapshot Name",
            kind: "text",
            required: true,
            defaultValue: `${String(fields["name"] ?? "vol")}-${new Date().toISOString().slice(0, 10)}`,
          },
        ],
        submitLabel: "Snapshot",
      },
    },
    {
      kind: "action",
      label: "Resize\u2026",
      action: {
        type: "prompt-nosql-command",
        command: "volume-resize",
        title: "Resize volume",
        description:
          "Block storage volumes can only grow \u2014 DigitalOcean does not support shrinking. The filesystem may need a manual `resize2fs` / `xfs_growfs` call after.",
        fields: [
          {
            key: "sizeGb",
            label: "New Size (GiB)",
            kind: "number",
            required: true,
            defaultValue: String(fields["sizeGb"] ?? "100"),
            description: "Must be greater than the current size.",
          },
        ],
        submitLabel: "Resize",
      },
    },
  ];
  if (isAttached) {
    headerActions.push({
      kind: "action",
      label: "Detach",
      variant: "danger",
      action: {
        type: "plugin-action",
        actionId: "detach",
        confirmMessage: `Detach this volume from droplet ${dropletIds[0]}? Make sure the filesystem is unmounted first.`,
        successMessage: "Detach queued.",
      },
    });
  }
  detail.headerActions = headerActions;
}

export function applySnapshotDetail(detail: DetailViewSchema, _resource: ResourceInstance): void {
  detail.headerActions = [
    { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
  ];
}

export function applyImageDetail(detail: DetailViewSchema, _resource: ResourceInstance): void {
  detail.headerActions = [
    { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
  ];
}

export function applyNfsShareDetail(detail: DetailViewSchema, resource: ResourceInstance): void {
  const fields = resource.fields;
  const mountTarget = String(
    resource.resolvedOutputs["mountTarget"] ?? fields["mountTarget"] ?? "",
  );
  const mountCmd = String(resource.resolvedOutputs["mountCommand"] ?? "");
  if (mountTarget || mountCmd) {
    detail.sections.push({
      kind: "section",
      title: "Mount",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "NFS Server", value: mountTarget, copyable: true },
            ...(mountCmd ? [{ key: "Mount Command", value: mountCmd, copyable: true }] : []),
          ],
        },
        {
          kind: "text",
          variant: "muted",
          content:
            "The mount target is only reachable from droplets and DOKS nodes in a VPC listed on this share. NFSv4.1 only.",
        },
      ],
    });
  }
}

export function renderDomainDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Domain Info",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Domain", value: String(fields["name"] ?? ""), copyable: true },
            { key: "Default TTL", value: formatDnsTtl(Number(fields["ttl"] ?? 0)) },
          ],
        },
      ],
    },
    {
      kind: "section",
      title: "Nameservers",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "NS 1", value: "ns1.digitalocean.com", copyable: true },
            { key: "NS 2", value: "ns2.digitalocean.com", copyable: true },
            { key: "NS 3", value: "ns3.digitalocean.com", copyable: true },
          ],
        },
        {
          kind: "text",
          content: "Point your domain registrar to these nameservers to use DigitalOcean DNS.",
          variant: "muted",
        },
      ],
    },
  ];
  return {
    title: resource.displayName,
    subtitle: "DNS Domain",
    status: { kind: "status-dot", status: "healthy", label: "Active" },
    sections,
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderDnsRecordDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const extraInfoItems: Array<{ key: string; value: string; copyable?: boolean }> = [];
  if (fields["port"] !== undefined) {
    extraInfoItems.push({ key: "Port", value: String(fields["port"]) });
  }
  if (fields["weight"] !== undefined) {
    extraInfoItems.push({ key: "Weight", value: String(fields["weight"]) });
  }
  if (fields["tag"]) {
    extraInfoItems.push({ key: "Tag", value: String(fields["tag"]) });
  }
  const opts = extraInfoItems.length > 0 ? { extraInfoItems } : {};
  return sharedRenderDnsRecordDetail(resource, opts);
}
