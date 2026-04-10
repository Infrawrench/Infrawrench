import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const WorkerRouteResourceType: ResourceTypeDefinition = {
  id: "worker-route",
  displayName: "Worker Route",
  pluralDisplayName: "Worker Routes",
  description: "A route mapping a URL pattern to a Cloudflare Worker",
  fields: [
    { key: "pattern", label: "Pattern", kind: "string", required: true },
    { key: "script", label: "Worker Script", kind: "string", required: false },
  ],
  outputs: [],
  parentTypeId: "zone",
  dashboardPinnable: false,
  iconKey: "route",
};
