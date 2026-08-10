import { f, rt } from "@infrawrench/plugin-base";

export const WorkerRouteResourceType = rt({
  name: "Worker Route",
  pinnable: false,
  id: "worker-route",
  description: "A route mapping a URL pattern to a Cloudflare Worker",
  fields: [
    f("pattern", "Pattern"),
    f("script", "Worker Script", { required: false }),
    f("zoneName", "Zone", { required: false }),
  ],
  outputs: [],
  dependsOn: [
    { fieldKey: "script", targetTypeId: "worker", label: "routes to" },
    { fieldKey: "zoneName", targetTypeId: "zone", targetKey: "name", label: "in zone" },
  ],
  parentTypeId: "zone",
  supportsCreate: true,
  iconKey: "route",
});
