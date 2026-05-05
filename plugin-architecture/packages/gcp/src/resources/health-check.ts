import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const HealthCheckResourceType: ResourceTypeDefinition = {
  id: "health-check",
  displayName: "Health Check",
  pluralDisplayName: "Health Checks",
  description: "A Google Cloud health check for load balancing",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "type", label: "Type", kind: "string", required: false },
    { key: "port", label: "Port", kind: "number", required: false },
    { key: "checkIntervalSec", label: "Check Interval (s)", kind: "number", required: false },
    { key: "timeoutSec", label: "Timeout (s)", kind: "number", required: false },
    { key: "healthyThreshold", label: "Healthy Threshold", kind: "number", required: false },
    { key: "unhealthyThreshold", label: "Unhealthy Threshold", kind: "number", required: false },
  ],
  outputs: [],
  dashboardPinnable: false,
  supportsCreate: true,
};
