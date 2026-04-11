import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DiskResourceType: ResourceTypeDefinition = {
  id: "azure-disk",
  displayName: "Managed Disk",
  pluralDisplayName: "Managed Disks",
  description: "An Azure Managed Disk",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "diskSizeGb", label: "Size (GB)", kind: "number", required: true },
    {
      key: "diskState",
      label: "Disk State",
      kind: "enum",
      required: true,
      enumValues: [
        "Unattached",
        "Attached",
        "Reserved",
        "ActiveSAS",
        "ReadyToUpload",
        "ActiveUpload",
        "ActiveSASFrozen",
      ],
    },
    { key: "sku", label: "SKU", kind: "string", required: false },
    { key: "osType", label: "OS Type", kind: "string", required: false },
    { key: "managedBy", label: "Managed By", kind: "string", required: false },
    { key: "encryption", label: "Encryption", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: true,
  iconKey: "volume",
  supportsCreate: true,
};
