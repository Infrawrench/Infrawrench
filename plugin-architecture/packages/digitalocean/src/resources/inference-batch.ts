import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const InferenceBatchResourceType: ResourceTypeDefinition = {
  id: "inference-batch",
  displayName: "Batch Inference Job",
  pluralDisplayName: "Batch Inference Jobs",
  description:
    "A DigitalOcean Batch Inference job — large asynchronous workloads against OpenAI or Anthropic provider APIs. Results return within 24 hours at significantly lower cost than real-time inference.",
  fields: [
    {
      key: "provider",
      label: "Provider",
      kind: "enum",
      required: true,
      enumValues: ["openai", "anthropic"],
    },
    {
      key: "endpoint",
      label: "Endpoint",
      kind: "enum",
      required: false,
      enumValues: ["/v1/chat/completions", "/v1/responses"],
      description: "Required for OpenAI; omit for Anthropic",
    },
    {
      key: "completionWindow",
      label: "Completion Window",
      kind: "enum",
      required: true,
      enumValues: ["24h"],
    },
    { key: "inputFileId", label: "Input File", kind: "string", required: true },
    {
      key: "outputFileId",
      label: "Output File",
      kind: "string",
      required: false,
      editable: false,
    },
    {
      key: "errorFileId",
      label: "Error File",
      kind: "string",
      required: false,
      editable: false,
    },
    { key: "status", label: "Status", kind: "string", required: false, editable: false },
    {
      key: "totalRequests",
      label: "Total Requests",
      kind: "number",
      required: false,
      editable: false,
    },
    {
      key: "completedRequests",
      label: "Completed Requests",
      kind: "number",
      required: false,
      editable: false,
    },
    {
      key: "failedRequests",
      label: "Failed Requests",
      kind: "number",
      required: false,
      editable: false,
    },
  ],
  outputs: [],
  dashboardPinnable: true,
  iconKey: "batch",
};
