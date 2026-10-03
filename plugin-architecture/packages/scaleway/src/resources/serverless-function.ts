import { f, o, rt } from "@infrawrench/plugin-base";
import { SCW_REGIONS } from "../locations.js";

export const ServerlessFunctionResourceType = rt({
  id: "serverless-function",
  name: "Serverless Function",
  description: "A Scaleway Serverless Function (functions/v1beta1)",
  fields: [
    f("name", "Name", { editable: false }),
    f("region", "Region", { kind: "enum", enumValues: SCW_REGIONS, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("runtime", "Runtime", { required: false, editable: false }),
    f("handler", "Handler", { required: false }),
    f("minScale", "Min Scale", { kind: "number", required: false }),
    f("maxScale", "Max Scale", { kind: "number", required: false }),
    f("memoryMb", "Memory (MB)", { kind: "number", required: false }),
    f("privacy", "Privacy", { required: false, editable: false }),
    f("errorMessage", "Error", { required: false, editable: false }),
    f("namespaceId", "Namespace", { required: false, editable: false }),
  ],
  outputs: [o("endpoint", "Endpoint URL")],
  // Edit = `PATCH /functions/{id}`: handler, scaling bounds and memory.
  supportsUpdate: true,
  // CPU, memory and instance count from Cockpit (needs the Cockpit token).
  supportsMetrics: true,
  iconKey: "function",
});
