import { f, o, rt } from "@infrawrench/plugin-base";
import { SCW_REGIONS } from "../locations.js";

export const RegistryNamespaceResourceType = rt({
  id: "registry-namespace",
  name: "Registry Namespace",
  description: "A Scaleway Container Registry namespace",
  equivalence: "container-registry",
  fields: [
    f("name", "Name", { editable: false }),
    f("region", "Region", {
      showcase: true,
      kind: "enum",
      enumValues: SCW_REGIONS,
      editable: false,
      sizing: "region",
    }),
    f("description", "Description", { required: false }),
    f("isPublic", "Public", { kind: "boolean", required: false }),
    f("status", "Status", { showcase: true, required: false, editable: false }),
    f("imageCount", "Images", { showcase: true, kind: "number", required: false, editable: false }),
    f("sizeGb", "Size (GB)", {
      showcase: true,
      kind: "number",
      required: false,
      editable: false,
      sizing: "disk-gb",
    }),
  ],
  outputs: [o("endpoint", "Registry Endpoint")],
  supportsCreate: true,
  // Edit = description and visibility (`PATCH /namespaces/{id}`).
  supportsUpdate: true,
  iconKey: "container-registry",
  postureChecks: [
    {
      id: "scaleway-registry-public",
      title: "Registry namespace is public",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "isPublic", when: "truthy" }],
      reason: "Anyone can pull every image in this namespace without credentials.",
    },
  ],
});
