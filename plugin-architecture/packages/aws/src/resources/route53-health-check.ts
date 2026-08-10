import { f, o, rt } from "@infrawrench/plugin-base";

export const Route53HealthCheckResourceType = rt({
  name: "Route 53 Health Check",
  id: "route53-health-check",
  description: "An Amazon Route 53 health check that monitors an endpoint or other health checks",
  fields: [
    f("healthCheckId", "Health Check ID"),
    f("type", "Type", {
      kind: "enum",
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
    }),
    f("ipAddress", "IP Address", { required: false }),
    f("port", "Port", { kind: "number", required: false }),
    f("resourcePath", "Resource Path", { required: false }),
    f("fqdn", "FQDN", { required: false }),
    f("requestInterval", "Request Interval (s)", { kind: "number", required: false }),
    f("failureThreshold", "Failure Threshold", { kind: "number", required: false }),
    f("disabled", "Disabled", { kind: "boolean", required: false }),
  ],
  outputs: [o("healthCheckId", "Health Check ID")],
  // The check targets a bare IPv4 address, so match it against the address a
  // resource answers to rather than its external id.
  dependsOn: [
    { fieldKey: "ipAddress", targetTypeId: "elastic-ip", targetKey: "publicIp", label: "checks" },
    { fieldKey: "ipAddress", targetTypeId: "ec2-instance", targetKey: "publicIp", label: "checks" },
  ],
  iconKey: "dns",
  supportsMetrics: true,
});
