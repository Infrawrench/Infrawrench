import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const TransformationResourceType: ResourceTypeDefinition = {
  id: "transformation",
  displayName: "Transformation",
  pluralDisplayName: "Transformations",
  description: "A named image/video transformation in Cloudinary",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "named", label: "Named", kind: "boolean", required: false },
    { key: "used", label: "Used", kind: "boolean", required: false },
    { key: "usageCount", label: "Usage Count", kind: "number", required: false },
  ],
  outputs: [{ key: "transformationName", label: "Transformation Name", sensitive: false }],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "transformation",
};
