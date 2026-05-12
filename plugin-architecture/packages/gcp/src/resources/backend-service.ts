import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const BackendServiceResourceType: ResourceTypeDefinition = {
  id: "backend-service",
  displayName: "Backend Service",
  pluralDisplayName: "Backend Services",
  description: "A Google Cloud Load Balancing backend service",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "protocol", label: "Protocol", kind: "string", required: false },
    { key: "port", label: "Port", kind: "number", required: false },
    { key: "portName", label: "Port Name", kind: "string", required: false },
    { key: "loadBalancingScheme", label: "LB Scheme", kind: "string", required: false },
    { key: "timeoutSec", label: "Timeout (s)", kind: "number", required: false },
    {
      key: "connectionDrainingTimeoutSec",
      label: "Connection Draining (s)",
      kind: "number",
      required: false,
    },
    { key: "healthCheckCount", label: "Health Checks", kind: "number", required: false },
    { key: "backendCount", label: "Backends", kind: "number", required: false },
    { key: "enableCDN", label: "CDN Enabled", kind: "boolean", required: false },
    { key: "sessionAffinity", label: "Session Affinity", kind: "string", required: false },
  ],
  outputs: [{ key: "selfLink", label: "Self Link", sensitive: false }],
  dashboardPinnable: true,
  supportsCreate: true,
};
