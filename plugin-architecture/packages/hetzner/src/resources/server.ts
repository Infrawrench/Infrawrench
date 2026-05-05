import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ServerResourceType: ResourceTypeDefinition = {
  id: "server",
  displayName: "Server",
  pluralDisplayName: "Servers",
  description: "A Hetzner Cloud virtual machine",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "status",
      label: "Status",
      kind: "enum",
      required: true,
      enumValues: [
        "running",
        "initializing",
        "starting",
        "stopping",
        "off",
        "deleting",
        "migrating",
        "rebuilding",
        "unknown",
      ],
    },
    {
      key: "serverType",
      label: "Server Type",
      kind: "string",
      required: true,
      description: "Server type slug, e.g. cx22, cpx11, cax11",
    },
    {
      key: "location",
      label: "Location",
      kind: "enum",
      required: true,
      enumValues: ["fsn1", "nbg1", "hel1", "ash", "hil", "sin"],
    },
    {
      key: "image",
      label: "Image",
      kind: "string",
      required: true,
      description: "OS image name, e.g. ubuntu-24.04",
    },
    {
      key: "datacenter",
      label: "Datacenter",
      kind: "string",
      required: false,
      description: "Datacenter name, e.g. fsn1-dc14",
    },
  ],
  outputs: [
    { key: "ipv4", label: "Public IPv4", sensitive: false },
    { key: "ipv6", label: "Public IPv6", sensitive: false },
    { key: "ipv4Private", label: "Private IPv4", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "server",
  sshEndpoint: {
    hostOutputKey: "ipv4",
    runningWhen: { fieldKey: "status", value: "running" },
    defaultUsername: "root",
  },
  supportsCreate: true,
};
