import { f, rt } from "@infrawrench/plugin-base";

export const GatewayResourceType = rt({
  id: "gateway",
  name: "Gateway",
  description: "An OVHcloud Public Cloud network gateway",
  fields: [
    f("name", "Name"),
    f("region", "Region"),
    f("model", "Model"),
    f("status", "Status", { required: false }),
    f("type", "Type", { required: false }),
    f("interfaces", "Interfaces", { kind: "number", required: false }),
  ],
  iconKey: "gateway",
});
