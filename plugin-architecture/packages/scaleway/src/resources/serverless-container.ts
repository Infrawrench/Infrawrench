import { f, o, rt } from "@infrawrench/plugin-base";
import { SCW_REGIONS } from "../locations.js";

export const ServerlessContainerResourceType = rt({
  id: "serverless-container",
  name: "Serverless Container",
  description: "A Scaleway Serverless Container (containers/v1)",
  fields: [
    f("name", "Name", { editable: false }),
    f("region", "Region", { kind: "enum", enumValues: SCW_REGIONS, editable: false }),
    f("status", "Status", {
      kind: "enum",
      required: false,
      enumValues: [
        "ready",
        "creating",
        "updating",
        "upgrading",
        "deleting",
        "locking",
        "locked",
        "error",
        "unknown_status",
      ],
      editable: false,
    }),
    f("image", "Image", { description: "Container image, e.g. rg.fr-par.scw.cloud/ns/app:1.2" }),
    f("minScale", "Min Scale", { kind: "number", required: false }),
    f("maxScale", "Max Scale", { kind: "number", required: false }),
    f("memoryMb", "Memory (MB)", { kind: "number", required: false }),
    f("vcpu", "vCPU", { kind: "number", required: false }),
    f("port", "Port", { kind: "number", required: false }),
    f("privacy", "Privacy", {
      kind: "enum",
      required: false,
      enumValues: ["public", "private"],
      editable: false,
    }),
    f("errorMessage", "Error", { required: false, editable: false }),
    f("namespaceId", "Namespace", { required: false, editable: false }),
  ],
  outputs: [o("endpoint", "Endpoint URL")],
  // Edit = `PATCH /containers/{id}`: image, scaling bounds and limits.
  supportsUpdate: true,
  iconKey: "container",
});
