import { f, o, rt } from "@infrawrench/plugin-base";

export const DropletResourceType = rt({
  name: "Droplet",
  id: "droplet",
  description: "A DigitalOcean virtual machine",
  fields: [
    f("name", "Name"),
    f("region", "Region", {
      kind: "enum",
      enumValues: [
        "nyc1",
        "nyc3",
        "sfo2",
        "sfo3",
        "ams3",
        "fra1",
        "sgp1",
        "lon1",
        "tor1",
        "blr1",
        "syd1",
      ],
    }),
    f("size", "Size", { description: "Droplet size slug, e.g. s-1vcpu-1gb" }),
    f("image", "Image", { description: "Image slug or ID, e.g. ubuntu-24-04-x64" }),
  ],
  outputs: [o("ipv4", "Public IPv4"), o("ipv4Private", "Private IPv4"), o("ipv6", "Public IPv6")],
  parentTypeId: "project",
  showInSidebar: true,
  supportsMetrics: true,
  iconKey: "droplet",
  sshEndpoint: {
    hostOutputKey: "ipv4",
    privateHostOutputKey: "ipv4Private",
    defaultUsername: "root",
    runningWhen: { fieldKey: "status", value: "active" },
  },
  supportsCreate: true,
});
