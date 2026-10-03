import type { DetailViewSchema, ResourceInstance } from "@infrawrench/plugin-base";
import { formatBytes } from "@infrawrench/plugin-base";

/**
 * Agents and Libraries: shapes, mappers and renderers.
 *
 * Both live on the ordinary data plane (`https://api.mistral.ai/v1`, bearer
 * workspace key) and both page with an opaque `page_token` /
 * `next_page_token` cursor, the newer scheme Mistral is moving its listings
 * to. `GET /v1/agents` (page-numbered) is deprecated in favour of
 * `GET /v1/agents/pages`, and the libraries listing's `page` parameter is
 * likewise deprecated in favour of `page_token`.
 *
 * Docs: https://docs.mistral.ai/openapi.yaml
 */

const DASH = "—";

export interface MistralAgentTool {
  type?: string;
  function?: { name?: string };
  library_ids?: string[];
  connector_id?: string;
  name?: string;
}

export interface MistralAgent {
  id?: string;
  name?: string;
  description?: string | null;
  instructions?: string | null;
  model?: string;
  tools?: MistralAgentTool[];
  completion_args?: Record<string, unknown>;
  handoffs?: string[] | null;
  version?: number;
  versions?: number[];
  version_message?: string | null;
  owner_id?: string | null;
  created_at?: string;
  updated_at?: string;
  deployment_chat?: boolean;
  source?: string;
}

export interface MistralLibrary {
  id?: string;
  name?: string;
  description?: string | null;
  created_at?: string;
  updated_at?: string;
  owner_id?: string | null;
  owner_type?: string;
  total_size?: number;
  nb_documents?: number;
}

/** One short label per tool: `web_search`, `function:get_weather`, … */
function toolLabel(tool: MistralAgentTool): string {
  const type = tool.type ?? "tool";
  if (type === "function" && tool.function?.name) return `function:${tool.function.name}`;
  if (type === "connector" && (tool.connector_id || tool.name)) {
    return `connector:${tool.connector_id || tool.name}`;
  }
  return type;
}

export function mapAgent(accountId: string, agent: MistralAgent, now: string): ResourceInstance {
  const id = String(agent.id ?? "");
  const tools = agent.tools ?? [];
  // Library ids attached through `document_library` tools, so the graph can
  // draw an edge to each library.
  const libraries = tools.flatMap((t) =>
    t.type === "document_library" ? (t.library_ids ?? []) : [],
  );
  return {
    id: `${accountId}:mistral-agent:${id}`,
    pluginId: "mistral",
    resourceTypeId: "mistral-agent",
    accountId,
    displayName: agent.name || id,
    externalId: id,
    fields: {
      agentId: id,
      name: agent.name ?? "",
      model: agent.model ?? "",
      description: agent.description ?? "",
      instructions: agent.instructions ?? "",
      tools: tools.map(toolLabel).join(", "),
      libraries: libraries.join(", "),
      handoffs: (agent.handoffs ?? []).join(", "),
      version: agent.version ?? 0,
      versionCount: (agent.versions ?? []).length,
      versionMessage: agent.version_message ?? "",
      deploymentChat: agent.deployment_chat ?? false,
      source: agent.source ?? "",
      createdAt: agent.created_at ?? "",
      updatedAt: agent.updated_at ?? "",
    },
    resolvedOutputs: {
      __completionArgs__: JSON.stringify(agent.completion_args ?? {}),
    },
    secretStates: [],
    createdAt: agent.created_at || now,
    updatedAt: agent.updated_at || now,
  };
}

export function mapLibrary(
  accountId: string,
  library: MistralLibrary,
  now: string,
): ResourceInstance {
  const id = String(library.id ?? "");
  return {
    id: `${accountId}:mistral-library:${id}`,
    pluginId: "mistral",
    resourceTypeId: "mistral-library",
    accountId,
    displayName: library.name || id,
    externalId: id,
    fields: {
      libraryId: id,
      name: library.name ?? "",
      description: library.description ?? "",
      documents: library.nb_documents ?? 0,
      totalSize: library.total_size ?? 0,
      ownerType: library.owner_type ?? "",
      createdAt: library.created_at ?? "",
      updatedAt: library.updated_at ?? "",
    },
    resolvedOutputs: {},
    secretStates: [],
    createdAt: library.created_at || now,
    updatedAt: library.updated_at || now,
  };
}

function text(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  return s || DASH;
}

export function renderAgentDetail(resource: ResourceInstance): DetailViewSchema {
  const f = resource.fields;
  let completionArgs: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(resource.resolvedOutputs["__completionArgs__"] ?? "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      completionArgs = parsed as Record<string, unknown>;
    }
  } catch {
    completionArgs = {};
  }
  const argRows = Object.entries(completionArgs)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([key, value]) => ({
      cells: {
        arg: key.replace(/_/g, " "),
        value: typeof value === "object" ? JSON.stringify(value) : String(value),
      },
    }));
  const instructions = String(f["instructions"] ?? "");

  return {
    title: resource.displayName,
    subtitle: `Mistral Agent · ${text(f["model"])}`,
    status: { kind: "status-dot", status: "healthy", label: `v${String(f["version"] ?? 0)}` },
    sections: [
      {
        kind: "section",
        title: "Agent",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Agent ID", value: text(f["agentId"]), copyable: true },
              { key: "Name", value: text(f["name"]) },
              { key: "Model", value: text(f["model"]) },
              { key: "Description", value: text(f["description"]) },
              { key: "Tools", value: text(f["tools"]) },
              { key: "Libraries", value: text(f["libraries"]) },
              { key: "Handoffs", value: text(f["handoffs"]) },
              { key: "Version", value: text(f["version"]) },
              { key: "Versions", value: text(f["versionCount"]) },
              { key: "Version Note", value: text(f["versionMessage"]) },
              { key: "Available in Le Chat", value: f["deploymentChat"] === true ? "Yes" : "No" },
              { key: "Created", value: text(f["createdAt"]) },
              { key: "Updated", value: text(f["updatedAt"]) },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Instructions",
        children: [
          instructions
            ? { kind: "text", variant: "mono", content: instructions, copyable: true }
            : { kind: "text", variant: "muted", content: "No instructions set." },
        ],
      },
      ...(argRows.length > 0
        ? [
            {
              kind: "section" as const,
              title: "Completion Arguments",
              children: [
                {
                  kind: "table" as const,
                  emphasizeFirstColumn: true,
                  columns: [
                    { key: "arg", label: "Argument" },
                    { key: "value", label: "Value", mono: true },
                  ],
                  rows: argRows,
                },
              ],
            },
          ]
        : []),
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderLibraryDetail(resource: ResourceInstance): DetailViewSchema {
  const f = resource.fields;
  const size = Number(f["totalSize"] ?? 0);
  return {
    title: resource.displayName,
    subtitle: `Mistral Library · ${Number(f["documents"] ?? 0).toLocaleString("en-US")} documents`,
    status: { kind: "status-dot", status: "healthy" },
    sections: [
      {
        kind: "section",
        title: "Library",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Library ID", value: text(f["libraryId"]), copyable: true },
              { key: "Name", value: text(f["name"]) },
              { key: "Description", value: text(f["description"]) },
              { key: "Documents", value: Number(f["documents"] ?? 0).toLocaleString("en-US") },
              { key: "Total Size", value: size > 0 ? formatBytes(size) : DASH },
              { key: "Owner", value: text(f["ownerType"]) },
              { key: "Created", value: text(f["createdAt"]) },
              { key: "Updated", value: text(f["updatedAt"]) },
            ],
          },
          {
            kind: "text",
            variant: "muted",
            content:
              "Attach this library to an agent with a document_library tool, or search it from a conversation. Documents are uploaded through the Libraries API.",
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}
