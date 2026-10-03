import { f, o, rt } from "@infrawrench/plugin-base";
import { AGENT_LANGUAGES } from "../agents.js";

/**
 * An ElevenAgents conversational agent. Listed from `GET /v1/convai/agents`
 * and hydrated from `GET /v1/convai/agents/{agent_id}` for its conversation
 * config; edited with `PATCH` on the same path.
 * https://elevenlabs.io/docs/api-reference/agents/list
 * https://elevenlabs.io/docs/api-reference/agents/update
 */
export const AgentResourceType = rt({
  name: "Agent",
  id: "agent",
  description:
    "An ElevenAgents conversational voice agent: its prompt, voice, LLM and the conversations it has handled",
  fields: [
    f("name", "Name"),
    f("agentId", "Agent ID", { required: false, editable: false }),
    f("language", "Language", {
      kind: "enum",
      required: false,
      enumValues: AGENT_LANGUAGES.map((language) => language.id),
    }),
    f("firstMessage", "First Message", {
      required: false,
      description:
        "What the agent says when a conversation starts. Leave empty to wait for the caller.",
    }),
    f("systemPrompt", "System Prompt", { required: false }),
    f("tags", "Tags", { required: false, description: "Comma-separated" }),
    // The edit form only renders static options, and voices and LLMs are
    // live lists, so these are chosen with pickers at create time.
    f("voiceId", "Voice ID", { required: false, editable: false }),
    f("ttsModelId", "TTS Model", { required: false, editable: false }),
    f("llm", "LLM", { required: false, editable: false }),
    f("temperature", "Temperature", { kind: "number", required: false, editable: false }),
    f("phoneNumbers", "Phone Numbers", { required: false, editable: false }),
    f("creator", "Created By", { required: false, editable: false }),
    f("lastCallAt", "Last Call", { required: false, editable: false }),
    f("archived", "Archived", { kind: "boolean", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("agentId", "Agent ID", {
      description: "Pass as agent_id when starting a conversation or a WebRTC/WebSocket session",
    }),
    o("voiceId", "Voice ID"),
  ],
  dependsOn: [{ fieldKey: "voiceId", targetTypeId: "voice", label: "speaks with" }],
  iconKey: "bot",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
});
