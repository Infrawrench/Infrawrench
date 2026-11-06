import { f, o, rt } from "@infrawrench/plugin-base";

export const InstanceTemplateResourceType = rt({
  name: "Instance Template",
  id: "instance-template",
  iconKey: "template",
  description: "A Google Compute Engine instance template used by managed instance groups",
  fields: [
    f("name", "Name"),
    f("machineType", "Machine Type", { showcase: true, required: false }),
    f("sourceImage", "Source Image", { required: false }),
    f("diskSizeGb", "Disk Size (GB)", { showcase: true, kind: "number", required: false }),
    f("description", "Description", { required: false }),
  ],
  outputs: [o("selfLink", "Self Link")],
  supportsCreate: true,
});
