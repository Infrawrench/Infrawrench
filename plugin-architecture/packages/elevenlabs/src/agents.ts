import type {
  DashboardStat,
  DetailViewSchema,
  MetricSeries,
  ResourceInstance,
  SchemaNode,
  SectionNode,
  SelectOption,
} from "@infrawrench/plugin-base";

/**
 * ElevenAgents (formerly Conversational AI): agents, their phone numbers and
 * the knowledge base documents they draw on. Wire shapes, mapping and
 * rendering live here; the client owns transport and dispatch.
 *
 * https://elevenlabs.io/docs/api-reference/agents/list
 * https://elevenlabs.io/docs/api-reference/conversations/list
 * https://elevenlabs.io/docs/api-reference/phone-numbers/list
 * https://elevenlabs.io/docs/api-reference/knowledge-base/list
 */

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface AgentSummaryWire {
  agent_id: string;
  name?: string | null;
  voice_id?: string | null;
  tags?: string[] | null;
  created_at_unix_secs?: number | null;
  last_call_time_unix_secs?: number | null;
  archived?: boolean | null;
  access_info?: {
    is_creator?: boolean | null;
    creator_name?: string | null;
    creator_email?: string | null;
    role?: string | null;
  } | null;
}

export interface AgentsPage {
  agents?: AgentSummaryWire[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export interface AgentDetailWire {
  agent_id: string;
  name?: string | null;
  tags?: string[] | null;
  conversation_config?: {
    agent?: {
      first_message?: string | null;
      language?: string | null;
      prompt?: {
        prompt?: string | null;
        llm?: string | null;
        temperature?: number | null;
      } | null;
    } | null;
    tts?: { voice_id?: string | null; model_id?: string | null } | null;
  } | null;
  metadata?: {
    created_at_unix_secs?: number | null;
    updated_at_unix_secs?: number | null;
  } | null;
  phone_numbers?: Array<{
    phone_number?: string | null;
    phone_number_id?: string | null;
    label?: string | null;
    provider?: string | null;
  }> | null;
  access_info?: AgentSummaryWire["access_info"];
}

export interface ConversationWire {
  agent_id?: string | null;
  conversation_id: string;
  start_time_unix_secs?: number | null;
  call_duration_secs?: number | null;
  message_count?: number | null;
  status?: string | null;
  call_successful?: string | null;
  call_summary_title?: string | null;
  direction?: string | null;
  main_language?: string | null;
  termination_reason?: string | null;
}

export interface ConversationsPage {
  conversations?: ConversationWire[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export interface PhoneNumberWire {
  phone_number_id: string;
  phone_number?: string | null;
  label?: string | null;
  provider?: string | null;
  assigned_agent?: { agent_id?: string | null; agent_name?: string | null } | null;
}

export interface KnowledgeBaseDocumentWire {
  id: string;
  name?: string | null;
  type?: string | null;
  metadata?: {
    created_at_unix_secs?: number | null;
    last_updated_at_unix_secs?: number | null;
    size_bytes?: number | null;
  } | null;
  dependent_agents?: unknown[] | null;
}

export interface KnowledgeBasePage {
  documents?: KnowledgeBaseDocumentWire[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export interface LlmListWire {
  llms?: Array<{
    llm?: string | null;
    max_context_limit?: number | null;
    deprecation_info?: { is_deprecated?: boolean | null } | null;
  }>;
}

/**
 * Languages an agent can be set to. The agent's `language` is free-form on the
 * wire; this is the documented core set, shared by the create and edit forms.
 * https://elevenlabs.io/docs/eleven-agents/customization/language
 */
export const AGENT_LANGUAGES: SelectOption[] = [
  { id: "en", label: "English" },
  { id: "es", label: "Spanish" },
  { id: "fr", label: "French" },
  { id: "de", label: "German" },
  { id: "it", label: "Italian" },
  { id: "pt", label: "Portuguese" },
  { id: "pl", label: "Polish" },
  { id: "nl", label: "Dutch" },
  { id: "sv", label: "Swedish" },
  { id: "da", label: "Danish" },
  { id: "fi", label: "Finnish" },
  { id: "no", label: "Norwegian" },
  { id: "cs", label: "Czech" },
  { id: "sk", label: "Slovak" },
  { id: "hu", label: "Hungarian" },
  { id: "ro", label: "Romanian" },
  { id: "bg", label: "Bulgarian" },
  { id: "hr", label: "Croatian" },
  { id: "el", label: "Greek" },
  { id: "tr", label: "Turkish" },
  { id: "ru", label: "Russian" },
  { id: "uk", label: "Ukrainian" },
  { id: "ar", label: "Arabic" },
  { id: "hi", label: "Hindi" },
  { id: "ta", label: "Tamil" },
  { id: "id", label: "Indonesian" },
  { id: "ms", label: "Malay" },
  { id: "fil", label: "Filipino" },
  { id: "vi", label: "Vietnamese" },
  { id: "ja", label: "Japanese" },
  { id: "ko", label: "Korean" },
  { id: "zh", label: "Chinese" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unixToIso(unix: number | null | undefined): string {
  if (!unix) return "";
  return new Date(unix * 1000).toISOString();
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

/** Comma-separated tags as typed in the edit form, trimmed and de-duplicated. */
export function parseTags(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Map an agent. `detail` (from `GET /v1/convai/agents/{id}`) carries the
 * conversation config; the list summary alone does not, so the client
 * hydrates each listed agent where it can and falls back to the summary.
 */
export function mapAgent(
  summary: AgentSummaryWire | undefined,
  detail: AgentDetailWire | undefined,
  accountId: string,
): ResourceInstance {
  const agentId = detail?.agent_id ?? summary?.agent_id ?? "";
  const name = detail?.name ?? summary?.name ?? agentId;
  const agentConfig = detail?.conversation_config?.agent;
  const tts = detail?.conversation_config?.tts;
  const voiceId = tts?.voice_id ?? summary?.voice_id ?? "";
  const tags = detail?.tags ?? summary?.tags ?? [];
  const access = detail?.access_info ?? summary?.access_info;
  const createdAt =
    unixToIso(detail?.metadata?.created_at_unix_secs ?? summary?.created_at_unix_secs) ||
    new Date().toISOString();
  const updatedAt = unixToIso(detail?.metadata?.updated_at_unix_secs) || createdAt;
  const lastCall = unixToIso(summary?.last_call_time_unix_secs);
  const phoneNumbers = (detail?.phone_numbers ?? [])
    .map((phone) => phone.phone_number ?? "")
    .filter(Boolean);

  return {
    id: `${accountId}:agent:${agentId}`,
    pluginId: "elevenlabs",
    resourceTypeId: "agent",
    accountId,
    displayName: name,
    fields: {
      name,
      agentId,
      ...(agentConfig?.language ? { language: agentConfig.language } : {}),
      ...(agentConfig?.first_message != null ? { firstMessage: agentConfig.first_message } : {}),
      ...(agentConfig?.prompt?.prompt != null ? { systemPrompt: agentConfig.prompt.prompt } : {}),
      ...(agentConfig?.prompt?.llm ? { llm: agentConfig.prompt.llm } : {}),
      ...(agentConfig?.prompt?.temperature != null
        ? { temperature: agentConfig.prompt.temperature }
        : {}),
      ...(voiceId ? { voiceId } : {}),
      ...(tts?.model_id ? { ttsModelId: tts.model_id } : {}),
      tags: tags.join(", "),
      ...(phoneNumbers.length ? { phoneNumbers: phoneNumbers.join(", ") } : {}),
      ...(access?.creator_name || access?.creator_email
        ? { creator: str(access.creator_name || access.creator_email) }
        : {}),
      ...(lastCall ? { lastCallAt: lastCall } : {}),
      archived: summary?.archived === true,
      createdAt,
    },
    resolvedOutputs: { agentId, voiceId },
    secretStates: [],
    externalId: agentId,
    createdAt,
    updatedAt,
  };
}

export function mapPhoneNumber(phone: PhoneNumberWire, accountId: string): ResourceInstance {
  const now = new Date().toISOString();
  const number = phone.phone_number ?? phone.phone_number_id;
  const label = phone.label ?? "";
  return {
    id: `${accountId}:phone-number:${phone.phone_number_id}`,
    pluginId: "elevenlabs",
    resourceTypeId: "phone-number",
    accountId,
    displayName: label ? `${label} (${number})` : number,
    fields: {
      phoneNumber: number,
      label,
      phoneNumberId: phone.phone_number_id,
      ...(phone.provider ? { provider: phone.provider } : {}),
      ...(phone.assigned_agent?.agent_id ? { agentId: phone.assigned_agent.agent_id } : {}),
      ...(phone.assigned_agent?.agent_name ? { agentName: phone.assigned_agent.agent_name } : {}),
    },
    resolvedOutputs: {
      phoneNumber: number,
      phoneNumberId: phone.phone_number_id,
    },
    secretStates: [],
    externalId: phone.phone_number_id,
    createdAt: now,
    updatedAt: now,
  };
}

export function mapKnowledgeBaseDocument(
  doc: KnowledgeBaseDocumentWire,
  accountId: string,
): ResourceInstance {
  const createdAt = unixToIso(doc.metadata?.created_at_unix_secs) || new Date().toISOString();
  const updatedAt = unixToIso(doc.metadata?.last_updated_at_unix_secs) || createdAt;
  const name = doc.name ?? doc.id;
  return {
    id: `${accountId}:knowledge-base-document:${doc.id}`,
    pluginId: "elevenlabs",
    resourceTypeId: "knowledge-base-document",
    accountId,
    displayName: name,
    fields: {
      name,
      documentId: doc.id,
      ...(doc.type ? { type: doc.type } : {}),
      ...(doc.metadata?.size_bytes != null ? { sizeBytes: doc.metadata.size_bytes } : {}),
      dependentAgents: doc.dependent_agents?.length ?? 0,
      createdAt,
      updatedAt,
    },
    resolvedOutputs: { documentId: doc.id },
    secretStates: [],
    externalId: doc.id,
    createdAt,
    updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Conversation analytics
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Daily series over the agent's conversations: count, successful count,
 * average duration and total talk time. Buckets are UTC days so they line up
 * with the cost graphs.
 */
export function conversationSeries(
  conversations: ConversationWire[],
  startMs: number,
  endMs: number,
): MetricSeries[] {
  const firstDay = Math.floor(startMs / DAY_MS) * DAY_MS;
  const buckets = new Map<number, { count: number; success: number; seconds: number }>();
  for (let day = firstDay; day <= endMs; day += DAY_MS) {
    buckets.set(day, { count: 0, success: 0, seconds: 0 });
  }
  for (const conversation of conversations) {
    const startedMs = (conversation.start_time_unix_secs ?? 0) * 1000;
    if (startedMs < startMs || startedMs > endMs) continue;
    const day = Math.floor(startedMs / DAY_MS) * DAY_MS;
    const bucket = buckets.get(day) ?? { count: 0, success: 0, seconds: 0 };
    bucket.count += 1;
    if (conversation.call_successful === "success") bucket.success += 1;
    bucket.seconds += conversation.call_duration_secs ?? 0;
    buckets.set(day, bucket);
  }
  const days = [...buckets.entries()].sort(([a], [b]) => a - b);
  return [
    {
      label: "Conversations",
      unit: "count",
      points: days.map(([timestamp, b]) => ({ timestamp, value: b.count })),
    },
    {
      label: "Successful Conversations",
      unit: "count",
      points: days.map(([timestamp, b]) => ({ timestamp, value: b.success })),
    },
    {
      label: "Average Call Duration",
      unit: "seconds",
      points: days.map(([timestamp, b]) => ({
        timestamp,
        value: b.count ? Number((b.seconds / b.count).toFixed(1)) : 0,
      })),
    },
    {
      label: "Talk Time",
      unit: "minutes",
      points: days.map(([timestamp, b]) => ({
        timestamp,
        value: Number((b.seconds / 60).toFixed(2)),
      })),
    },
  ];
}

/** Dashboard stats over a window of conversations (the client passes 7 days). */
export function conversationStats(conversations: ConversationWire[]): DashboardStat[] {
  const total = conversations.length;
  const judged = conversations.filter(
    (c) => c.call_successful === "success" || c.call_successful === "failure",
  );
  const successes = judged.filter((c) => c.call_successful === "success").length;
  const seconds = conversations.reduce((sum, c) => sum + (c.call_duration_secs ?? 0), 0);
  const stats: DashboardStat[] = [{ label: "Conversations (7 d)", value: String(total) }];
  if (judged.length) {
    const rate = successes / judged.length;
    stats.push({
      label: "Success Rate (7 d)",
      value: `${Math.round(rate * 100)}%`,
      variant: rate >= 0.8 ? "status-healthy" : rate >= 0.5 ? "status-degraded" : "status-error",
    });
  }
  if (total) {
    stats.push({ label: "Avg Duration", value: formatDuration(seconds / total) });
    stats.push({ label: "Talk Time (7 d)", value: formatDuration(seconds) });
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function kv(key: string, value: unknown, copyable = false) {
  return { key, value: str(value), ...(copyable ? { copyable: true } : {}) };
}

function parseConversations(raw: string | undefined): ConversationWire[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ConversationWire[]) : [];
  } catch {
    return [];
  }
}

export function renderAgentDetail(resource: ResourceInstance): DetailViewSchema {
  const f = resource.fields;
  const archived = f["archived"] === true;
  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Agent",
      children: [
        {
          kind: "key-value-list",
          items: [
            kv("Name", f["name"] ?? resource.displayName),
            kv("Agent ID", f["agentId"], true),
            ...(f["language"] ? [kv("Language", f["language"])] : []),
            ...(f["tags"] ? [kv("Tags", f["tags"])] : []),
            ...(f["creator"] ? [kv("Created By", f["creator"])] : []),
            ...(f["createdAt"] ? [kv("Created", f["createdAt"])] : []),
            ...(f["lastCallAt"] ? [kv("Last Call", f["lastCallAt"])] : []),
            ...(f["phoneNumbers"] ? [kv("Phone Numbers", f["phoneNumbers"])] : []),
          ],
        },
      ],
    },
    {
      kind: "section",
      title: "Voice and Model",
      children: [
        {
          kind: "key-value-list",
          items: [
            kv("Voice ID", f["voiceId"] || "Default", Boolean(f["voiceId"])),
            kv("TTS Model", f["ttsModelId"] || "Default"),
            kv("LLM", f["llm"] || "Default"),
            ...(f["temperature"] != null ? [kv("Temperature", f["temperature"])] : []),
          ],
        },
      ],
    },
  ];

  if (f["firstMessage"]) {
    sections.push({
      kind: "section",
      title: "First Message",
      children: [{ kind: "text", content: str(f["firstMessage"]) }],
    });
  }
  if (f["systemPrompt"]) {
    sections.push({
      kind: "section",
      title: "System Prompt",
      children: [{ kind: "text", content: str(f["systemPrompt"]), variant: "mono" }],
    });
  }

  const conversations = parseConversations(resource.resolvedOutputs["__conversations__"]);
  if (conversations.length) {
    const rows = conversations.map((c) => ({
      cells: {
        started: unixToIso(c.start_time_unix_secs) || "-",
        title: str(c.call_summary_title) || c.conversation_id,
        duration: c.call_duration_secs != null ? formatDuration(c.call_duration_secs) : "-",
        messages: str(c.message_count ?? "-"),
        result: str(c.call_successful || c.status) || "-",
      } as Record<string, string>,
    }));
    const table: SchemaNode = {
      kind: "table",
      columns: [
        { key: "started", label: "Started", mono: true },
        { key: "title", label: "Summary", width: "wide" },
        { key: "duration", label: "Duration", width: "narrow" },
        { key: "messages", label: "Messages", width: "narrow" },
        { key: "result", label: "Result", width: "narrow" },
      ],
      rows,
    };
    sections.push({ kind: "section", title: "Recent Conversations", children: [table] });
  }

  return {
    title: resource.displayName,
    subtitle: `ElevenLabs Agent · ${str(f["language"]) || "en"}`,
    status: {
      kind: "status-dot",
      status: archived ? "info" : "healthy",
      label: archived ? "Archived" : "Active",
    },
    sections,
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    metricsCapability: { defaultTimeRangeMs: 30 * 24 * 60 * 60 * 1000 },
  };
}

export function renderPhoneNumberDetail(resource: ResourceInstance): DetailViewSchema {
  const f = resource.fields;
  const assigned = Boolean(f["agentId"]);
  return {
    title: resource.displayName,
    subtitle: `Phone Number · ${str(f["provider"]) || "unknown provider"}`,
    status: {
      kind: "status-dot",
      status: assigned ? "healthy" : "info",
      label: assigned ? "Assigned" : "Unassigned",
    },
    sections: [
      {
        kind: "section",
        title: "Phone Number",
        children: [
          {
            kind: "key-value-list",
            items: [
              kv("Number", f["phoneNumber"], true),
              ...(f["label"] ? [kv("Label", f["label"])] : []),
              kv("Phone Number ID", f["phoneNumberId"], true),
              ...(f["provider"] ? [kv("Provider", f["provider"])] : []),
              kv("Agent", f["agentName"] || f["agentId"] || "None"),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderKnowledgeBaseDocumentDetail(resource: ResourceInstance): DetailViewSchema {
  const f = resource.fields;
  const size = Number(f["sizeBytes"] ?? 0);
  const dependents = Number(f["dependentAgents"] ?? 0);
  return {
    title: resource.displayName,
    subtitle: `Knowledge Base · ${str(f["type"]) || "document"}`,
    status: {
      kind: "status-dot",
      status: dependents > 0 ? "healthy" : "info",
      label:
        dependents > 0 ? `Used by ${dependents} agent${dependents === 1 ? "" : "s"}` : "Unused",
    },
    sections: [
      {
        kind: "section",
        title: "Document",
        children: [
          {
            kind: "key-value-list",
            items: [
              kv("Name", f["name"] ?? resource.displayName),
              kv("Document ID", f["documentId"], true),
              ...(f["type"] ? [kv("Type", f["type"])] : []),
              ...(size ? [kv("Size", `${(size / 1024).toFixed(1)} KB`)] : []),
              kv("Dependent Agents", dependents),
              ...(f["createdAt"] ? [kv("Created", f["createdAt"])] : []),
              ...(f["updatedAt"] ? [kv("Updated", f["updatedAt"])] : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}
