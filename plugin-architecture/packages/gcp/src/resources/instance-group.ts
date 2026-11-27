import { f, rt } from "@infrawrench/plugin-base";

export const InstanceGroupResourceType = rt({
  name: "Instance Group",
  id: "instance-group",
  iconKey: "layers",
  description: "A Google Compute Engine managed or unmanaged instance group",
  fields: [
    f("name", "Name"),
    f("zone", "Zone", { required: false }),
    f("region", "Region", { showcase: true, required: false }),
    f("size", "Size", { showcase: true, kind: "number", required: false }),
    f("isManaged", "Managed", { kind: "boolean", required: false }),
    f("targetSize", "Target Size", {
      kind: "number",
      required: false,
      // A group at its autoscaler's maximum cannot scale out any further.
      usage: { limit: { field: "autoscalerMaxSize" }, unit: "instances", label: "Instances" },
    }),
    f("autoscalerMaxSize", "Autoscaler Max Size", {
      kind: "number",
      required: false,
      editable: false,
      description: "Most instances the group's autoscaler may scale out to",
    }),
    f("instanceTemplate", "Instance Template", { required: false }),
    f("status", "Status", { showcase: true, required: false }),
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
