import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * One Claude model the account is entitled to call.
 *
 * `GET /v1/models` returns a rich `capabilities` object per model — batch
 * eligibility, citations, code execution, structured outputs, vision, PDF
 * input, extended thinking and context-management strategies — alongside the
 * model's real context window (`max_input_tokens`) and output cap
 * (`max_tokens`). We flatten each of those into a field so the list view can
 * be filtered on them.
 *
 * Docs: https://platform.claude.com/docs/en/api/models-list
 */
export const ModelResourceType = rt({
  name: "Model",
  id: "model",
  description:
    "A Claude model available to this API key, with its context window, output cap and full capability matrix (vision, PDF, batch, citations, code execution, structured outputs, thinking).",
  fields: [
    f("modelId", "Model ID", { editable: false }),
    f("displayName", "Display Name", { editable: false }),
    f("releasedAt", "Released", { required: false, editable: false }),
    f("maxInputTokens", "Context Window (tokens)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("maxTokens", "Max Output Tokens", { kind: "number", required: false, editable: false }),
    f("vision", "Image Input", { kind: "boolean", required: false, editable: false }),
    f("pdfInput", "PDF Input", { kind: "boolean", required: false, editable: false }),
    f("batch", "Batch API", { kind: "boolean", required: false, editable: false }),
    f("citations", "Citations", { kind: "boolean", required: false, editable: false }),
    f("codeExecution", "Code Execution", { kind: "boolean", required: false, editable: false }),
    f("structuredOutputs", "Structured Outputs", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("thinking", "Extended Thinking", { kind: "boolean", required: false, editable: false }),
    f("contextManagement", "Context Management", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("thinkingTypes", "Thinking Modes", { required: false, editable: false }),
    f("effortLevels", "Effort Levels", { required: false, editable: false }),
  ],
  outputs: [
    o("modelId", "Model ID", {
      description:
        'Value to pass as the `model` parameter on /v1/messages, e.g. "claude-opus-4-6".',
    }),
    o("displayName", "Display Name"),
    o("maxInputTokens", "Context Window"),
  ],
  supportsCreate: false,
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "model",
});
