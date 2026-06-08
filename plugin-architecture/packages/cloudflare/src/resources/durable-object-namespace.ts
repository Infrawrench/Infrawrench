import { f, o, rt } from "@infrawrench/plugin-base";

export const DurableObjectNamespaceResourceType = rt({
  name: "Durable Object Namespace",
  id: "durable-object-namespace",
  description: "A Cloudflare Workers Durable Object namespace (defined by a deployed Worker class)",
  fields: [
    f("name", "Name", { required: false }),
    f("class", "Class", { required: false }),
    f("script", "Worker Script", { required: false }),
    f("useSqlite", "SQLite Storage", { kind: "boolean", required: false }),
  ],
  outputs: [o("namespaceId", "Namespace ID")],
  supportsMetrics: true,
  iconKey: "compute",
});
