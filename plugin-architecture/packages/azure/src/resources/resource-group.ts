import { f, o, rt } from "@infrawrench/plugin-base";

export const ResourceGroupResourceType = rt({
  name: "Resource Group",
  id: "azure-resource-group",
  description: "An Azure Resource Group",
  fields: [
    f("name", "Name"),
    f("location", "Location", { showcase: true }),
    f("provisioningState", "Provisioning State", { showcase: true }),
  ],
  outputs: [o("resourceId", "Resource ID")],
  iconKey: "project",
  supportsCreate: true,
});
