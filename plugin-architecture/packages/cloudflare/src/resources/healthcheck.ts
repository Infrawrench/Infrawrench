import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const HealthcheckResourceType: ResourceTypeDefinition = {
  id: "healthcheck",
  displayName: "Health Check",
  pluralDisplayName: "Health Checks",
  description: "A Cloudflare standalone health check (active origin monitor)",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "address", label: "Address", kind: "string", required: true },
    { key: "type", label: "Type", kind: "string", required: false, editable: false },
    { key: "status", label: "Status", kind: "string", required: false, editable: false },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "suspended", label: "Suspended", kind: "boolean", required: false },
    { key: "interval", label: "Interval (s)", kind: "number", required: false },
    { key: "timeout", label: "Timeout (s)", kind: "number", required: false },
    { key: "retries", label: "Retries", kind: "number", required: false },
    {
      key: "consecutiveFails",
      label: "Consecutive Fails",
      kind: "number",
      required: false,
      editable: false,
    },
    {
      key: "consecutiveSuccesses",
      label: "Consecutive Successes",
      kind: "number",
      required: false,
      editable: false,
    },
  ],
  outputs: [],
  parentTypeId: "zone",
  dashboardPinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "load-balancer",
};
