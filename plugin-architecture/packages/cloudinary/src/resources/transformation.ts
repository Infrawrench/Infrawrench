import { f, o, rt } from "@infrawrench/plugin-base";

export const TransformationResourceType = rt({
  name: "Transformation",
  id: "transformation",
  description: "A named image/video transformation in Cloudinary",
  fields: [
    f("name", "Name", { editable: false }),
    f("named", "Named", { kind: "boolean", required: false, editable: false }),
    f("used", "Used", { kind: "boolean", required: false, editable: false }),
    f("usageCount", "Usage Count", { kind: "number", required: false, editable: false }),
    f("allowedForStrict", "Allowed for Strict", {
      kind: "boolean",
      required: false,
      description: "Allow this transformation when strict transformations are enabled",
    }),
    f("definition", "New Definition", {
      required: false,
      description:
        "Replace the transformation parameters, e.g. w_200,h_200,c_fill. Applies only to newly derived assets; existing derived assets keep the old definition until invalidated.",
    }),
  ],
  outputs: [o("transformationName", "Transformation Name")],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "transformation",
  attachTargets: [
    {
      pluginId: "cloudinary",
      resourceTypeId: "upload-preset",
      verb: "Apply to preset",
    },
  ],
});
