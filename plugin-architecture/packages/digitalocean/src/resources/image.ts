import { f, o, rt } from "@infrawrench/plugin-base";

export const ImageResourceType = rt({
  name: "Image",
  id: "image",
  description: "A custom Droplet image (uploaded image, backup, or snapshot promoted to an image)",
  fields: [
    f("name", "Name"),
    f("type", "Type", {
      kind: "enum",
      required: false,
      enumValues: ["snapshot", "backup", "custom", "distribution", "application"],
    }),
    f("distribution", "Distribution", { required: false }),
    f("slug", "Slug", { required: false }),
    f("regions", "Regions", { required: false }),
    f("sizeGb", "Size (GB)", { kind: "number", required: false }),
    f("minDiskSize", "Min Disk (GB)", { kind: "number", required: false }),
    f("status", "Status", { required: false }),
  ],
  outputs: [],
  parentTypeId: "project",
  showInSidebar: true,
  iconKey: "image",
});
