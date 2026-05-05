import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const InstanceTemplateResourceType: ResourceTypeDefinition = {
  id: "instance-template",
  displayName: "Instance Template",
  pluralDisplayName: "Instance Templates",
  description: "A Google Compute Engine instance template used by managed instance groups",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "machineType", label: "Machine Type", kind: "string", required: false },
    { key: "sourceImage", label: "Source Image", kind: "string", required: false },
    { key: "diskSizeGb", label: "Disk Size (GB)", kind: "number", required: false },
    { key: "description", label: "Description", kind: "string", required: false },
  ],
  outputs: [{ key: "selfLink", label: "Self Link", sensitive: false }],
  dashboardPinnable: true,
  supportsCreate: true,
};
