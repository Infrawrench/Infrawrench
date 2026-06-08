import { f, o, rt } from "@infrawrench/plugin-base";

export const TransformationResourceType = rt({
  name: "Transformation",
  id: "transformation",
  description: "A named image/video transformation in Cloudinary",
  fields: [
    f("name", "Name"),
    f("named", "Named", { kind: "boolean", required: false }),
    f("used", "Used", { kind: "boolean", required: false }),
    f("usageCount", "Usage Count", { kind: "number", required: false }),
  ],
  outputs: [o("transformationName", "Transformation Name")],
  supportsCreate: true,
  iconKey: "transformation",
  attachTargets: [
    {
      pluginId: "cloudinary",
      resourceTypeId: "upload-preset",
      verb: "Apply to preset",
    },
  ],
});
