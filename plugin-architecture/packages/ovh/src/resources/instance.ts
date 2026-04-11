import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const InstanceResourceType: ResourceTypeDefinition = {
  id: "instance",
  displayName: "Instance",
  pluralDisplayName: "Instances",
  description: "An OVHcloud Public Cloud virtual machine",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "region",
      label: "Region",
      kind: "enum",
      required: true,
      enumValues: [
        "GRA1",
        "GRA3",
        "GRA5",
        "GRA7",
        "GRA9",
        "GRA11",
        "SBG5",
        "BHS5",
        "WAW1",
        "DE1",
        "UK1",
        "SGP1",
        "SYD1",
      ],
    },
    {
      key: "flavorName",
      label: "Flavor",
      kind: "string",
      required: true,
      description: "Instance flavor name, e.g. b2-7",
    },
    {
      key: "imageName",
      label: "Image",
      kind: "string",
      required: true,
      description: "OS image name, e.g. Ubuntu 24.04",
    },
    {
      key: "status",
      label: "Status",
      kind: "string",
      required: false,
    },
  ],
  outputs: [
    { key: "ipv4", label: "Public IPv4", sensitive: false },
    { key: "ipv6", label: "Public IPv6", sensitive: false },
    { key: "ipv4Private", label: "Private IPv4", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "instance",
  sshEndpoint: {
    hostOutputKey: "ipv4",
    runningWhen: { fieldKey: "status", value: "ACTIVE" },
  },
  supportsCreate: true,
};
