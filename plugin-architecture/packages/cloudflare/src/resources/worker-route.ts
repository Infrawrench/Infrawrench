import { f, rt } from "@infrawrench/plugin-base";

export const WorkerRouteResourceType = rt({
  name: "Worker Route",
  pinnable: false,
  id: "worker-route",
  description: "A route mapping a URL pattern to a Cloudflare Worker",
  fields: [f("pattern", "Pattern"), f("script", "Worker Script", { required: false })],
  outputs: [],
  parentTypeId: "zone",
  supportsCreate: true,
  iconKey: "route",
});
