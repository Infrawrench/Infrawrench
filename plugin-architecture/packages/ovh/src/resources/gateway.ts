import { f, rt } from "@infrawrench/plugin-base";

export const GatewayResourceType = rt({
  id: "gateway",
  name: "Gateway",
  description: "An OVHcloud Public Cloud network gateway",
  fields: [
    f("name", "Name"),
    f("region", "Region", { showcase: true }),
    f("model", "Model", { showcase: true }),
    f("status", "Status", { showcase: true, required: false }),
    f("type", "Type", { showcase: true, required: false }),
    f("interfaces", "Interfaces", { kind: "number", required: false }),
  ],
  iconKey: "gateway",
});
