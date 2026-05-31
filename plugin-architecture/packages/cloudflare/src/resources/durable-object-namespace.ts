import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DurableObjectNamespaceResourceType: ResourceTypeDefinition = {
  id: "durable-object-namespace",
  displayName: "Durable Object Namespace",
  pluralDisplayName: "Durable Object Namespaces",
  description: "A Cloudflare Workers Durable Object namespace (defined by a deployed Worker class)",
  fields: [
    { key: "name", label: "Name", kind: "string", required: false },
    { key: "class", label: "Class", kind: "string", required: false },
    { key: "script", label: "Worker Script", kind: "string", required: false },
    { key: "useSqlite", label: "SQLite Storage", kind: "boolean", required: false },
  ],
  outputs: [{ key: "namespaceId", label: "Namespace ID", sensitive: false }],
  dashboardPinnable: false,
  iconKey: "compute",
};
