import { f, o, rt } from "@infrawrench/plugin-base";

export const HyperdriveResourceType = rt({
  name: "Hyperdrive",
  plural: "Hyperdrive Configs",
  id: "hyperdrive",
  description: "A Cloudflare Hyperdrive connection cache configuration",
  fields: [
    f("name", "Name"),
    f("originHost", "Origin Host", { required: false }),
    f("originPort", "Origin Port", { kind: "number", required: false }),
    f("originScheme", "Scheme", { required: false }),
    f("database", "Database", { required: false }),
    f("user", "User", { required: false }),
    f("password", "Password", {
      kind: "password",
      required: false,
      description: "Database password. Leave blank to keep the current one.",
    }),
    f("cachingDisabled", "Caching Disabled", { kind: "boolean", required: false }),
  ],
  outputs: [o("hyperdriveId", "Hyperdrive ID")],
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
});
