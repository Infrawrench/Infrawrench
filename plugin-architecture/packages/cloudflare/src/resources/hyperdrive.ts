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
    {
      key: "password",
      label: "Password",
      kind: "password",
      required: false,
      description: "Database password. Leave blank to keep the current one.",
    },
    { key: "cachingDisabled", label: "Caching Disabled", kind: "boolean", required: false },
  ],
  // Hyperdrive exposes no externally usable connection string: the binding's
  // connection string only resolves inside a Worker at runtime and is never
  // returned by the API, and the origin connection can't be reconstructed
  // because Cloudflare never returns the origin password. So the only stable
  // output is the config id — what a Worker `[[hyperdrive]]` binding references.
  // (No PostgreSQL peer for the same reason: there's nothing a SQL client could
  // connect to.)
  outputs: [{ key: "hyperdriveId", label: "Hyperdrive ID", sensitive: false }],
  dashboardPinnable: true,
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "hyperdrive",
  secretExportTemplates: [
    {
      id: "hyperdrive-connection",
      displayName: "Hyperdrive Binding",
      description: "Hyperdrive config id for a Worker `[[hyperdrive]]` binding",
      entries: [{ envKey: "HYPERDRIVE_ID", outputKey: "hyperdriveId" }],
    },
  ],
};
