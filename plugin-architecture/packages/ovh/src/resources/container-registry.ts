import { f, o, rt } from "@infrawrench/plugin-base";

export const ContainerRegistryResourceType = rt({
  id: "container-registry",
  name: "Container Registry",
  description: "An OVHcloud Managed Private Registry (Harbor)",
  equivalence: "container-registry",
  fields: [
    f("name", "Name"),
    f("region", "Region", { showcase: true, sizing: "region" }),
    f("status", "Status", {
      showcase: true,
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
    f("sizeGb", "Size (GB)", {
      showcase: true,
      kind: "number",
      required: false,
      sizing: "disk-gb",
    }),
    f("version", "Harbor Version", { showcase: true, required: false }),
    f("iamEnabled", "OVHcloud IAM", { kind: "boolean", required: false }),
  ],
  outputs: [o("url", "Registry URL")],
  supportsCreate: true,
  iconKey: "container-registry",
});
