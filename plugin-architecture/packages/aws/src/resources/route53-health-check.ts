import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const Route53HealthCheckResourceType: ResourceTypeDefinition = {
  id: "route53-health-check",
  displayName: "Route 53 Health Check",
  pluralDisplayName: "Route 53 Health Checks",
  description: "An Amazon Route 53 health check that monitors an endpoint or other health checks",
  fields: [
    { key: "healthCheckId", label: "Health Check ID", kind: "string", required: true },
    {
      key: "type",
      label: "Type",
      kind: "enum",
      required: true,
      enumValues: [
        "HTTP",
        "HTTPS",
        "HTTP_STR_MATCH",
        "HTTPS_STR_MATCH",
        "TCP",
        "CALCULATED",
        "CLOUDWATCH_METRIC",
        "RECOVERY_CONTROL",
      ],
    },
    { key: "ipAddress", label: "IP Address", kind: "string", required: false },
    { key: "port", label: "Port", kind: "number", required: false },
    { key: "resourcePath", label: "Resource Path", kind: "string", required: false },
    { key: "fqdn", label: "FQDN", kind: "string", required: false },
    { key: "requestInterval", label: "Request Interval (s)", kind: "number", required: false },
    { key: "failureThreshold", label: "Failure Threshold", kind: "number", required: false },
    { key: "disabled", label: "Disabled", kind: "boolean", required: false },
  ],
  outputs: [{ key: "healthCheckId", label: "Health Check ID", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "dns",
  supportsMetrics: true,
};
