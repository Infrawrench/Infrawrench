import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DropletResourceType: ResourceTypeDefinition = {
  id: "droplet",
  displayName: "Droplet",
  pluralDisplayName: "Droplets",
  description: "A DigitalOcean virtual machine",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "region",
      label: "Region",
      kind: "enum",
      required: true,
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
    },
    {
      key: "size",
      label: "Size",
      kind: "string",
      required: true,
      description: "Droplet size slug, e.g. s-1vcpu-1gb",
    },
    {
      key: "image",
      label: "Image",
      kind: "string",
      required: true,
      description: "Image slug or ID, e.g. ubuntu-24-04-x64",
    },
  ],
  outputs: [
    { key: "ipv4", label: "Public IPv4", sensitive: false },
    { key: "ipv4Private", label: "Private IPv4", sensitive: false },
  ],
  parentTypeId: "project",
  dashboardPinnable: true,
  supportsMetrics: true,
  iconKey: "droplet",
  sshEndpoint: { hostOutputKey: "ipv4", defaultUsername: "root" },
  supportsCreate: true,
};
