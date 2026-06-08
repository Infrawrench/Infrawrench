import { f, o, rt } from "@infrawrench/plugin-base";

export const GceDiskResourceType = rt({
  name: "Persistent Disk",
  pinnable: false,
  id: "gce-disk",
  description: "A Google Compute Engine persistent disk",
  fields: [
    f("name", "Name"),
    f("zone", "Zone"),
    f("sizeGb", "Size (GB)", { kind: "number" }),
    f("type", "Disk Type", { required: false }),
    f("status", "Status", { required: false }),
  ],
  outputs: [],
  supportsCreate: true,
  attachTargets: [
    { pluginId: "gcp", resourceTypeId: "gce-instance", matchField: "zone", verb: "Attach" },
  ],
});
