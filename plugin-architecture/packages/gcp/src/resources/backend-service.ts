import { f, o, rt } from "@infrawrench/plugin-base";

export const BackendServiceResourceType = rt({
  name: "Backend Service",
  id: "backend-service",
  description: "A Google Cloud Load Balancing backend service",
  fields: [
    f("name", "Name"),
    f("region", "Region", { required: false }),
    f("description", "Description", { required: false }),
    f("protocol", "Protocol", { required: false }),
    f("port", "Port", { kind: "number", required: false }),
    f("portName", "Port Name", { required: false }),
    f("loadBalancingScheme", "LB Scheme", { required: false }),
    f("timeoutSec", "Timeout (s)", { kind: "number", required: false }),
    f("connectionDrainingTimeoutSec", "Connection Draining (s)", {
      kind: "number",
      required: false,
    }),
    f("healthCheckCount", "Health Checks", { kind: "number", required: false }),
    f("healthCheckNames", "Health Check Names", {
      required: false,
      description: "Names of the health checks probing this backend service",
    }),
    f("backendCount", "Backends", { kind: "number", required: false }),
    f("backendGroups", "Backend Groups", {
      required: false,
      description: "Names of the instance groups or network endpoint groups behind this service",
    }),
    f("enableCDN", "CDN Enabled", { kind: "boolean", required: false }),
    f("sessionAffinity", "Session Affinity", { required: false }),
  ],
  outputs: [o("selfLink", "Self Link")],
  // Health checks are keyed by bare name; instance groups by `zone/name`, so
  // match those on their `name` field instead. Network endpoint groups land in
  // `backendGroups` too and simply match nothing — they aren't synced.
  dependsOn: [
    { fieldKey: "healthCheckNames", targetTypeId: "health-check", label: "checked by" },
    {
      fieldKey: "backendGroups",
      targetTypeId: "instance-group",
      targetKey: "name",
      label: "routes to",
    },
  ],
  supportsCreate: true,
  supportsMetrics: true,
});
