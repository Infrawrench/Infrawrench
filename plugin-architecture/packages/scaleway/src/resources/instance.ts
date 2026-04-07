import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const InstanceResourceType: ResourceTypeDefinition = {
  id: "instance",
  displayName: "Instance",
  pluralDisplayName: "Instances",
  description: "A Scaleway virtual machine",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "zone",
      label: "Zone",
      kind: "enum",
      required: true,
      enumValues: [
        "fr-par-1", "fr-par-2", "fr-par-3",
        "nl-ams-1", "nl-ams-2", "nl-ams-3",
        "pl-waw-1", "pl-waw-2", "pl-waw-3",
      ],
    },
    {
      key: "commercialType",
      label: "Commercial Type",
      kind: "string",
      required: true,
      description: "Instance type, e.g. DEV1-S, GP1-S, PRO2-S",
    },
    {
      key: "image",
      label: "Image",
      kind: "string",
      required: true,
      description: "Image ID or name",
    },
    {
      key: "state",
      label: "State",
      kind: "enum",
      required: false,
      enumValues: ["running", "stopped", "stopped in place", "starting", "stopping"],
    },
  ],
  outputs: [
    { key: "publicIp", label: "Public IP", sensitive: false },
    { key: "privateIp", label: "Private IP", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "instance",
  sshEndpoint: { hostOutputKey: "publicIp" },
  supportsCreate: true,
};
