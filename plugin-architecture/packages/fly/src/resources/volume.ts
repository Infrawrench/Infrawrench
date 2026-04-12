import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const VolumeResourceType: ResourceTypeDefinition = {
  id: "volume",
  displayName: "Volume",
  pluralDisplayName: "Volumes",
  description: "A Fly.io persistent storage volume",
  parentTypeId: "app",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "state",
      label: "State",
      kind: "enum",
      required: true,
      enumValues: ["created", "destroyed", "restoring"],
    },
    {
      key: "sizeGb",
      label: "Size (GB)",
      kind: "number",
      required: true,
    },
    {
      key: "region",
      label: "Region",
      kind: "string",
      required: true,
      description: "Fly.io region code",
    },
    {
      key: "encrypted",
      label: "Encrypted",
      kind: "boolean",
      required: false,
    },
    {
      key: "attachedMachineId",
      label: "Attached Machine",
      kind: "string",
      required: false,
      description: "ID of the machine this volume is attached to",
    },
    {
      key: "appName",
      label: "App",
      kind: "string",
      required: true,
      description: "Name of the parent app",
    },
  ],
  outputs: [],
  dashboardPinnable: true,
  iconKey: "volume",
};
