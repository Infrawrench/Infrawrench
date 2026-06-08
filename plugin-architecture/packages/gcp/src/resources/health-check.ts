import { f, o, rt } from "@infrawrench/plugin-base";

export const HealthCheckResourceType = rt({
  name: "Health Check",
  pinnable: false,
  id: "health-check",
  description: "A Google Cloud health check for load balancing",
  fields: [
    f("name", "Name"),
    f("type", "Type", { required: false }),
    f("port", "Port", { kind: "number", required: false }),
    f("checkIntervalSec", "Check Interval (s)", { kind: "number", required: false }),
    f("timeoutSec", "Timeout (s)", { kind: "number", required: false }),
    f("healthyThreshold", "Healthy Threshold", { kind: "number", required: false }),
    f("unhealthyThreshold", "Unhealthy Threshold", { kind: "number", required: false }),
  ],
  outputs: [o("selfLink", "Self Link")],
  supportsCreate: true,
});
