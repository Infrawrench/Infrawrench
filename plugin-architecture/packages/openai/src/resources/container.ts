import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * `GET/POST /v1/containers`, `DELETE /v1/containers/{id}` — verified 2026-07-29
 * against openapi.yaml v2.3.0 (`ListContainers`, `CreateContainer`,
 * `DeleteContainer`). There is no update verb.
 */
export const ContainerResourceType = rt({
  name: "Container",
  id: "container",
  description:
    "A sandbox the Code Interpreter tool runs inside. Containers expire after an idle window and are billed per session.",
  fields: [
    f("name", "Name"),
    f("status", "Status", { required: false }),
    f("memoryLimit", "Memory Limit", {
      kind: "enum",
      enumValues: ["1g", "4g", "16g", "64g"],
      required: false,
    }),
    f("expiresAfterMinutes", "Idle Expiry (minutes)", { kind: "number", required: false }),
    f("networkPolicy", "Network Policy", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("lastActiveAt", "Last Active", { required: false }),
  ],
  outputs: [o("containerId", "Container ID"), o("name", "Name")],
  iconKey: "container",
  supportsCreate: true,
  supportsDelete: true,
});
