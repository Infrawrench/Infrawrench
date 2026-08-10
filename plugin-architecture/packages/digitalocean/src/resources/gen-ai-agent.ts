import { f, o, rt } from "@infrawrench/plugin-base";

export const GenAiAgentResourceType = rt({
  name: "Agent",
  id: "gen-ai-agent",
  description:
    "A DigitalOcean Gradient AI Platform agent — a deployed conversational endpoint built on a foundation model, optionally augmented with knowledge bases, function routes, and child agents.",
  fields: [
    f("name", "Name"),
    f("region", "Region", { required: false }),
    f("modelUuid", "Model", {
      required: false,
      description: "Foundation model UUID powering the agent",
    }),
    f("modelName", "Model Name", { required: false, editable: false }),
    f("modelRouterUuid", "Inference Router", {
      required: false,
      description:
        "Optional Inference Router UUID. When set, the router decides which model serves each call; modelUuid is ignored.",
    }),
    f("modelRouterName", "Router Name", { required: false, editable: false }),
    f("description", "Description", { required: false }),
    f("instruction", "Instruction", {
      required: false,
      description: "System prompt / behaviour guidance for the agent",
    }),
    f("projectId", "Project ID", { required: false, editable: false }),
    f("temperature", "Temperature", { kind: "number", required: false }),
    f("maxTokens", "Max Tokens", { kind: "number", required: false }),
    f("k", "Top-k", { kind: "number", required: false }),
    f("status", "Status", { required: false, editable: false }),
    f("deploymentVisibility", "Endpoint Visibility", {
      required: false,
      editable: false,
      description: "Public or Private. Toggleable via the Make Public/Private header action.",
    }),
    f("knowledgeBaseCount", "Knowledge Bases", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("knowledgeBaseUuids", "Knowledge Base UUIDs", {
      required: false,
      editable: false,
      description: "Comma-separated UUIDs of the knowledge bases attached to this agent",
    }),
    f("deploymentUrl", "Deployment URL", { required: false, editable: false }),
  ],
  outputs: [
    o("deploymentUrl", "Deployment URL", { description: "Public chatbot URL for this agent" }),
    o("agentEndpoint", "Agent Endpoint", {
      description: "OpenAI-compatible base URL for this agent's inference endpoint",
    }),
  ],
  dependsOn: [
    { fieldKey: "projectId", targetTypeId: "project", label: "in project" },
    { fieldKey: "modelRouterUuid", targetTypeId: "gen-ai-model-router", label: "routes through" },
    // Comma-joined KB uuids — one edge per attached knowledge base.
    {
      fieldKey: "knowledgeBaseUuids",
      targetTypeId: "gen-ai-knowledge-base",
      label: "retrieves from",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "agent",
});
