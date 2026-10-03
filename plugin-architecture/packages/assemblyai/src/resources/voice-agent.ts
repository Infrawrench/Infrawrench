import { f, o, rt } from "@infrawrench/plugin-base";
import { VOICES, WEBHOOK_EVENTS } from "../voice-agents.js";

/**
 * A Voice Agent API agent: a saved prompt, voice and toolset that realtime
 * sessions connect to by id. Lives on `https://agents.assemblyai.com/v1`.
 *
 * https://www.assemblyai.com/docs/voice-agents/voice-agent-api/api-spec/create-agent
 */
export const VoiceAgentResourceType = rt({
  name: "Voice Agent",
  id: "voice-agent",
  description:
    "A saved AssemblyAI voice agent: system prompt, voice, greeting and tools that realtime sessions connect to by id",
  fields: [
    f("name", "Name"),
    f("voiceId", "Voice", {
      kind: "enum",
      required: false,
      enumValues: VOICES.map((v) => v.id),
    }),
    f("greeting", "Greeting", { required: false }),
    f("systemPrompt", "System Prompt", { required: false }),
    f("agentId", "Agent ID", { required: false, editable: false }),
    f("toolCount", "Tools", { kind: "number", required: false, editable: false }),
    f("tools", "Tool Names", { required: false, editable: false }),
    f("llmModel", "LLM", { required: false, editable: false }),
    f("llmBaseUrl", "LLM Endpoint", { required: false, editable: false }),
    f("keyterms", "Key Terms", { required: false, editable: false }),
    f("inputFormat", "Input Audio", { required: false, editable: false }),
    f("outputFormat", "Output Audio", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("agentId", "Agent ID", { description: "Pass as the agent id when opening a session." }),
    o("agentName", "Agent Name"),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "voice",
});

/**
 * One realtime conversation with a voice agent. Sessions are opened over the
 * agent websocket, so they are listed, inspected and deleted but never
 * created here.
 *
 * https://www.assemblyai.com/docs/voice-agents/voice-agent-api/api-spec/list-sessions
 */
export const AgentSessionResourceType = rt({
  name: "Agent Session",
  id: "agent-session",
  description:
    "A realtime voice agent conversation, with its duration, how it closed and links to its recording and timeline",
  fields: [
    f("status", "Status", { required: false }),
    f("agentName", "Agent", { required: false }),
    f("agentId", "Agent ID", { required: false }),
    f("durationSeconds", "Duration (s)", { kind: "number", required: false }),
    f("closeReason", "Close Reason", { required: false }),
    f("createdAt", "Started", { required: false }),
    f("endedAt", "Ended", { required: false }),
    f("sessionId", "Session ID", { required: false }),
  ],
  outputs: [o("sessionId", "Session ID")],
  dependsOn: [
    { fieldKey: "agentId", targetTypeId: "voice-agent", targetKey: "agentId", label: "uses" },
  ],
  supportsDelete: true,
  iconKey: "mic",
});

/**
 * A webhook subscription for voice agent session and call events, either
 * account-wide or scoped to one agent. The signing secret is write-only.
 *
 * https://www.assemblyai.com/docs/voice-agents/voice-agent-api/api-spec/create-webhook-subscription
 */
export const WebhookSubscriptionResourceType = rt({
  name: "Webhook Subscription",
  id: "webhook-subscription",
  description:
    "Delivers voice agent session and call events to an HTTPS endpoint, for every agent or just one",
  fields: [
    f("url", "Delivery URL"),
    f("enabled", "Enabled", { kind: "boolean", required: false }),
    ...WEBHOOK_EVENTS.map((event) =>
      f(event.field, event.label, {
        kind: "boolean",
        required: false,
        description: `Deliver \`${event.id}\` events.`,
      }),
    ),
    f("newSecret", "Rotate Signing Secret", {
      kind: "password",
      required: false,
      description:
        "Set a new 32 to 256 character secret to rotate it. Leave blank to keep the current one.",
    }),
    f("scope", "Scope", { required: false, editable: false }),
    f("agentId", "Agent ID", { required: false, editable: false }),
    f("events", "Events", { required: false, editable: false }),
    f("secretVersion", "Secret Version", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("subscriptionId", "Subscription ID"),
    o("url", "Delivery URL"),
    o("signingSecret", "Signing Secret", {
      sensitive: true,
      description: "Only available on the response that created it, and only when generated.",
    }),
  ],
  dependsOn: [
    { fieldKey: "agentId", targetTypeId: "voice-agent", targetKey: "agentId", label: "scoped to" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "webhook",
});

/**
 * One model in the LLM Gateway catalogue (`GET /v1/models`), with list prices.
 * Read-only: the catalogue is AssemblyAI's.
 *
 * https://www.assemblyai.com/docs/llm-gateway/api-reference/list-available-models
 */
export const LlmModelResourceType = rt({
  name: "LLM Gateway Model",
  id: "llm-model",
  description:
    "A model available through AssemblyAI's LLM Gateway, with context length, supported parameters, regions and per-token prices",
  fields: [
    f("modelId", "Model ID"),
    f("creator", "Creator", { required: false }),
    f("contextLength", "Context Length", { kind: "number", required: false }),
    f("maxCompletionTokens", "Max Completion Tokens", { kind: "number", required: false }),
    f("promptPrice", "Prompt Price (USD / 1M tokens)", { kind: "number", required: false }),
    f("completionPrice", "Completion Price (USD / 1M tokens)", { kind: "number", required: false }),
    f("cacheReadPrice", "Cache Read Price (USD / 1M tokens)", { kind: "number", required: false }),
    f("regions", "Regions", { required: false }),
    f("supportedParameters", "Supported Parameters", { required: false }),
    f("retirementDate", "Retirement Date", { required: false }),
  ],
  outputs: [o("modelId", "Model ID", { description: "Pass as `model` to the LLM Gateway." })],
  supportsDelete: false,
  iconKey: "model",
});
