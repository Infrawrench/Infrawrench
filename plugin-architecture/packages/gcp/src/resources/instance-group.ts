import { f, rt } from "@infrawrench/plugin-base";

export const InstanceGroupResourceType = rt({
  name: "Instance Group",
  id: "instance-group",
  description: "A Google Compute Engine managed or unmanaged instance group",
  fields: [
    f("name", "Name"),
    f("zone", "Zone", { required: false }),
    f("region", "Region", { required: false }),
    f("size", "Size", { kind: "number", required: false }),
    f("isManaged", "Managed", { kind: "boolean", required: false }),
    f("targetSize", "Target Size", { kind: "number", required: false }),
    f("instanceTemplate", "Instance Template", { required: false }),
    f("status", "Status", { required: false }),
  ],
  outputs: [],
  dependsOn: [
    { fieldKey: "instanceTemplate", targetTypeId: "instance-template", label: "from template" },
  ],
  supportsCreate: true,
  attachTargets: [
    {
      pluginId: "gcp",
      resourceTypeId: "backend-service",
      verb: "Add backend",
    },
  ],
});
