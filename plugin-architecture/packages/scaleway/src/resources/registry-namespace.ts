import { f, o, rt } from "@infrawrench/plugin-base";
import { SCW_REGIONS } from "../locations.js";

export const RegistryNamespaceResourceType = rt({
  id: "registry-namespace",
  name: "Registry Namespace",
  description: "A Scaleway Container Registry namespace",
  fields: [
    f("name", "Name", { editable: false }),
    f("region", "Region", { kind: "enum", enumValues: SCW_REGIONS, editable: false }),
    f("description", "Description", { required: false }),
    f("isPublic", "Public", { kind: "boolean", required: false }),
    f("status", "Status", { required: false, editable: false }),
    f("imageCount", "Images", { kind: "number", required: false, editable: false }),
    f("sizeGb", "Size (GB)", { kind: "number", required: false, editable: false }),
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
