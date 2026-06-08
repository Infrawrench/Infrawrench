import { f, o, rt } from "@infrawrench/plugin-base";

export const InferenceBatchResourceType = rt({
  name: "Batch Inference Job",
  id: "inference-batch",
  description:
    "A DigitalOcean Batch Inference job — large asynchronous workloads against OpenAI or Anthropic provider APIs. Results return within 24 hours at significantly lower cost than real-time inference.",
  fields: [
    f("provider", "Provider", { kind: "enum", enumValues: ["openai", "anthropic"] }),
    f("endpoint", "Endpoint", {
      kind: "enum",
      required: false,
      enumValues: ["/v1/chat/completions", "/v1/responses"],
      description: "Required for OpenAI; omit for Anthropic",
    }),
    f("completionWindow", "Completion Window", { kind: "enum", enumValues: ["24h"] }),
    f("inputFileId", "Input File"),
    f("outputFileId", "Output File", { required: false, editable: false }),
    f("errorFileId", "Error File", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("totalRequests", "Total Requests", { kind: "number", required: false, editable: false }),
    f("completedRequests", "Completed Requests", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("failedRequests", "Failed Requests", { kind: "number", required: false, editable: false }),
  ],
  outputs: [],
  iconKey: "batch",
});
