import { f, o, rt } from "@infrawrench/plugin-base";

export const DiskResourceType = rt({
  name: "Managed Disk",
  id: "azure-disk",
  description: "An Azure Managed Disk",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("diskSizeGb", "Size (GB)", { kind: "number" }),
    f("diskState", "Disk State", {
      kind: "enum",
      enumValues: [
        "Unattached",
        "Attached",
        "Reserved",
        "ActiveSAS",
        "ReadyToUpload",
        "ActiveUpload",
        "ActiveSASFrozen",
      ],
    }),
    f("sku", "SKU", { required: false }),
    f("osType", "OS Type", { required: false }),
    f("managedBy", "Managed By", { required: false }),
    f("encryption", "Encryption", { required: false }),
  ],
  outputs: [],
  iconKey: "volume",
  supportsCreate: true,
  supportsMetrics: true,
  attachTargets: [
    {
      pluginId: "azure",
      resourceTypeId: "azure-vm",
      matchField: "location",
      verb: "Attach",
    },
  ],
});
