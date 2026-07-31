import { f, rt } from "@infrawrench/plugin-base";

export const HealthcheckResourceType = rt({
  name: "Health Check",
  pinnable: false,
  id: "healthcheck",
  description: "A Cloudflare standalone health check (active origin monitor)",
  fields: [
    f("name", "Name"),
    f("address", "Address"),
    f("type", "Type", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("description", "Description", { required: false }),
    f("suspended", "Suspended", { kind: "boolean", required: false }),
    f("interval", "Interval (s)", { kind: "number", required: false }),
    f("timeout", "Timeout (s)", { kind: "number", required: false }),
    f("retries", "Retries", { kind: "number", required: false }),
    f("consecutiveFails", "Consecutive Fails", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("consecutiveSuccesses", "Consecutive Successes", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("zoneName", "Zone", { required: false, editable: false }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "zoneName", targetTypeId: "zone", targetKey: "name", label: "in zone" }],
  parentTypeId: "zone",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "load-balancer",
});
