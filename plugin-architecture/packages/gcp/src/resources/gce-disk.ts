import { f, rt } from "@infrawrench/plugin-base";

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
    f("attachedTo", "Attached Instances", {
      required: false,
      description: "Comma-separated names of instances this disk is attached to",
    }),
  ],
  outputs: [],
  // Comma-separated instance names — one edge per attachment. Instances are
  // indexed by their bare `name` field; the externalId carries project/zone too.
  dependsOn: [
    {
      fieldKey: "attachedTo",
      targetTypeId: "gce-instance",
      targetKey: "name",
      label: "attached to",
    },
  ],
  supportsCreate: true,
  // equals-"" (not when:"empty") on purpose: resources synced before the
  // lister populated attachedTo have the field absent, and `equals` never
  // matches an absent field — so stale rows aren't falsely flagged until a
  // fresh sync writes "" or a real instance list. status is lifecycle only
  // (READY whether or not attached), hence the extra READY guard.
  orphanRule: {
    conditions: [
      { fieldKey: "attachedTo", when: "equals", value: "" },
      { fieldKey: "status", when: "equals", value: "READY" },
    ],
    reason: "Persistent disk is not attached to any instance",
  },
  attachTargets: [
    { pluginId: "gcp", resourceTypeId: "gce-instance", matchField: "zone", verb: "Attach" },
  ],
});
