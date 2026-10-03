import { f, o, rt } from "@infrawrench/plugin-base";
import { LANGUAGE_CODES } from "../languages.js";

/**
 * A Cartesia Managed Agent (Line). Listed from `GET /agents`, edited with
 * `PATCH /agents/{agent_id}` and deleted with `DELETE /agents/{agent_id}`;
 * its deployments come from `GET /agents/{agent_id}/deployments`.
 * https://docs.cartesia.ai/api-reference/agents/agents/list
 * https://docs.cartesia.ai/api-reference/agents/agents/update
 */
export const AgentResourceType = rt({
  name: "Agent",
  id: "agent",
  description:
    "A Cartesia voice agent: the voice and language it speaks, its phone numbers and its deployments",
  fields: [
    f("name", "Name"),
    f("agentId", "Agent ID", { required: false, editable: false }),
    f("description", "Description", { required: false }),
    f("ttsLanguage", "Language", { kind: "enum", required: false, enumValues: LANGUAGE_CODES }),
    f("noiseSuppressionLevel", "Noise Suppression (0-100)", {
      kind: "number",
      required: false,
      description:
        "How much noise suppression to apply to the caller's audio: 0 is off, 100 is maximum",
    }),
    // The edit form only renders static options and voices are a live list,
    // so the voice is changed in the Cartesia playground.
    f("ttsVoice", "Voice ID", { required: false, editable: false }),
    f("phoneNumbers", "Phone Numbers", { required: false, editable: false }),
    f("deploymentCount", "Deployments", { kind: "number", required: false, editable: false }),
    f("webhookId", "Webhook ID", { required: false, editable: false }),
    f("gitRepository", "Git Repository", { required: false, editable: false }),
    f("gitDeployBranch", "Deploy Branch", { required: false, editable: false }),
    f("selfHostedUrl", "Self-Hosted URL", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("agentId", "Agent ID", { description: "The agent_id used by the Agents WebSocket API" }),
  ],
  dependsOn: [{ fieldKey: "ttsVoice", targetTypeId: "voice", label: "speaks with" }],
  iconKey: "bot",
  supportsUpdate: true,
});
