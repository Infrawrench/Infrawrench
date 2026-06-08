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
    f("backendCount", "Backends", { kind: "number", required: false }),
    f("enableCDN", "CDN Enabled", { kind: "boolean", required: false }),
    f("sessionAffinity", "Session Affinity", { required: false }),
  ],
  outputs: [o("selfLink", "Self Link")],
  supportsCreate: true,
});
