/**
 * Detail view for DigitalOcean Gradient AI agents — the chat playground tab,
 * the embed-script generator, and the knowledge-base / function-route summary.
 */
import type { ActionNode, DetailViewSchema, ResourceInstance } from "@infrawrench/plugin-base";
import { parseJsonArray } from "./shared.js";

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
