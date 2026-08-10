import { f, rt } from "@infrawrench/plugin-base";

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
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
    { fieldKey: "managedBy", targetTypeId: "azure-vm", targetKey: "name", label: "attached to" },
  ],
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
  postureChecks: [
    {
      id: "azure-disk-unencrypted",
      title: "Disk not encrypted at rest",
      severity: "medium",
      category: "encryption",
      conditions: [{ fieldKey: "encryption", when: "equals", value: "None" }],
      reason:
        "The managed disk reports no at-rest encryption setting; enable platform-managed or customer-managed key encryption.",
    },
  ],
});
