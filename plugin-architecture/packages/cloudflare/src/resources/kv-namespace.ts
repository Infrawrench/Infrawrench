import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const KVNamespaceResourceType: ResourceTypeDefinition = {
  id: "kv-namespace",
  displayName: "KV Namespace",
  pluralDisplayName: "KV Namespaces",
  description: "A Cloudflare Workers KV namespace",
  fields: [
    { key: "title", label: "Title", kind: "string", required: true },
    { key: "supportsUrlEncoding", label: "URL Encoding", kind: "boolean", required: false },
  ],
  outputs: [
    { key: "namespaceId", label: "Namespace ID", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "kv",
};
