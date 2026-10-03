import { f, o, rt } from "@infrawrench/plugin-base";

export const ContainerRegistryResourceType = rt({
  id: "container-registry",
  name: "Container Registry",
  description: "An OVHcloud Managed Private Registry (Harbor)",
  fields: [
    f("name", "Name"),
    f("region", "Region"),
    f("status", "Status", {
      kind: "enum",
      required: false,
      enumValues: [
        "DELETED",
        "DELETING",
        "ERROR",
        "INSTALLING",
        "READY",
        "RESTORING",
        "SUSPENDED",
        "SUSPENDING",
        "UPDATING",
      ],
    }),
    f("sizeGb", "Size (GB)", { kind: "number", required: false }),
    f("version", "Harbor Version", { required: false }),
    f("iamEnabled", "OVHcloud IAM", { kind: "boolean", required: false }),
  ],
  outputs: [o("url", "Registry URL")],
  supportsCreate: true,
  iconKey: "container-registry",
});
