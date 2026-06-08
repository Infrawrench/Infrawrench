import { f, o, rt } from "@infrawrench/plugin-base";

export const KVNamespaceResourceType = rt({
  name: "KV Namespace",
  id: "kv-namespace",
  description: "A Cloudflare Workers KV namespace",
  fields: [
    f("title", "Title"),
    f("supportsUrlEncoding", "URL Encoding", { kind: "boolean", required: false }),
  ],
  outputs: [o("namespaceId", "Namespace ID")],
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "kv",
  secretExportTemplates: [
    {
      id: "kv-binding",
      displayName: "KV Binding",
      description: "Namespace ID for wrangler `[[kv_namespaces]]` bindings.",
      entries: [{ envKey: "KV_NAMESPACE_ID", outputKey: "namespaceId" }],
    },
  ],
});
