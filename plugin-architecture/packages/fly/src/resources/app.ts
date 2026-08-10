import { f, o, rt } from "@infrawrench/plugin-base";

export const AppResourceType = rt({
  name: "App",
  id: "app",
  description: "A Fly.io application that groups machines, volumes, and networking",
  fields: [
    f("name", "Name"),
    f("status", "Status", { kind: "enum", enumValues: ["deployed", "pending", "suspended"] }),
    f("organization", "Organization", {
      required: false,
      description: "Organization the app belongs to",
    }),
    f("machineCount", "Machines", {
      kind: "number",
      required: false,
      description: "Number of machines in this app",
    }),
    f("volumeCount", "Volumes", {
      kind: "number",
      required: false,
      description: "Number of volumes in this app",
    }),
    f("network", "Network", { required: false, description: "Private network name" }),
  ],
  outputs: [
    o("hostname", "Hostname", { description: "Public hostname (<app>.fly.dev)" }),
    o("appName", "App Name", {
      description: "The app's name — used by machines/volumes to reference their parent app",
    }),
  ],
  iconKey: "app",
  // `<app>.fly.dev`. App names are globally unique on Fly, so the name match
  // is exact; the hostname itself is an output, not a field, so it isn't
  // available as a `hostKeys` source.
  dnsServiceHosts: [
    {
      id: "fly-dev",
      label: "Fly.io app hostname",
      hostPattern: String.raw`([a-z0-9][a-z0-9-]*)\.fly\.dev`,
      reason:
        "Fly app names are globally unique and released when the app is destroyed, so anyone can create an app with the same name and serve it under your hostname.",
    },
  ],
  supportsCreate: true,
  supportsMetrics: true,
});
