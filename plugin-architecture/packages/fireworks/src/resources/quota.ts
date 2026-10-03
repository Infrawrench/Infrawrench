import { f, o, rt } from "@infrawrench/plugin-base";

export const QuotaResourceType = rt({
  name: "Quota",
  id: "quota",
  description: "An accelerator quota granted to this Fireworks account, per accelerator and region",
  fields: [
    f("quotaId", "Quota ID", { editable: false }),
    f("value", "Enforced Limit", {
      kind: "number",
      required: false,
      description: "Lower it below the approved maximum to cap spend.",
    }),
    f("maxValue", "Approved Maximum", { kind: "number", required: false, editable: false }),
    f("usage", "In Use", { kind: "number", required: false, editable: false }),
    f("updateTime", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("quotaId", "Quota ID"), o("quotaName", "Quota Resource Name")],
  supportsUpdate: true,
  supportsDelete: false,
  pinnable: false,
  iconKey: "scaling",
});
