import { f, rt } from "@infrawrench/plugin-base";
import { SCW_ZONES as ZONES } from "../locations.js";

export const BlockVolumeResourceType = rt({
  id: "block-volume",
  name: "Block Volume",
  description: "A Scaleway Block Storage volume (sbs_volume)",
  fields: [
    f("name", "Name"),
    f("zone", "Zone", { kind: "enum", enumValues: ZONES }),
    f("sizeGb", "Size (GB)", { kind: "number" }),
    f("perfIops", "IOPS", { kind: "enum", required: false, enumValues: ["5000", "15000"] }),
    f("status", "Status", { required: false }),
    f("attachedInstanceId", "Attached Instance ID", {
      required: false,
      description: "ID of the instance this volume is attached to, if any",
    }),
  ],
  // `attachedInstanceId` is a bare server uuid while an instance's external id
  // is `{zone}/{id}`. Block volumes are zonal and only attach within their own
  // zone, so composing with `zone` names exactly one instance.
  dependsOn: [
    {
      fieldKey: "attachedInstanceId",
      targetTypeId: "instance",
      matchTemplate: "{zone}/{attachedInstanceId}",
      label: "attached to",
    },
  ],
  supportsCreate: true,
  iconKey: "volume",
  attachTargets: [
    { pluginId: "scaleway", resourceTypeId: "instance", matchField: "zone", verb: "Attach" },
  ],
});
