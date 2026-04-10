import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const HyperdriveResourceType: ResourceTypeDefinition = {
  id: "hyperdrive",
  displayName: "Hyperdrive",
  pluralDisplayName: "Hyperdrive Configs",
  description: "A Cloudflare Hyperdrive connection cache configuration",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "originHost", label: "Origin Host", kind: "string", required: false },
    { key: "originPort", label: "Origin Port", kind: "number", required: false },
    { key: "originScheme", label: "Scheme", kind: "string", required: false },
    { key: "database", label: "Database", kind: "string", required: false },
    { key: "user", label: "User", kind: "string", required: false },
    { key: "cachingDisabled", label: "Caching Disabled", kind: "boolean", required: false },
  ],
  outputs: [
    { key: "hyperdriveId", label: "Hyperdrive ID", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "hyperdrive",
};
