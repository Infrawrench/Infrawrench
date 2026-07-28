import { f, o, rt } from "@infrawrench/plugin-base";

export const QuotaResourceType = rt({
  name: "Quota",
  id: "quota",
  description: "An accelerator quota granted to this Fireworks account, per accelerator and region",
  fields: [
    f("quotaId", "Quota ID"),
    f("value", "Enforced Limit", { kind: "number", required: false }),
    f("maxValue", "Approved Maximum", { kind: "number", required: false }),
    f("usage", "In Use", { kind: "number", required: false }),
    f("updateTime", "Updated", { required: false }),
  ],
  outputs: [o("quotaId", "Quota ID"), o("quotaName", "Quota Resource Name")],
  supportsDelete: false,
  pinnable: false,
  iconKey: "scaling",
});
