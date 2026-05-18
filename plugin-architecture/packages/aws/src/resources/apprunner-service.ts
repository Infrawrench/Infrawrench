import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const AppRunnerServiceResourceType: ResourceTypeDefinition = {
  id: "apprunner-service",
  displayName: "App Runner Service",
  pluralDisplayName: "App Runner Services",
  description: "An AWS App Runner service",
  fields: [
    { key: "serviceName", label: "Name", kind: "string", required: true },
    {
      key: "status",
      label: "Status",
      kind: "enum",
      required: true,
      enumValues: [
        "CREATE_FAILED",
        "RUNNING",
        "DELETED",
        "DELETE_FAILED",
        "PAUSED",
        "OPERATION_IN_PROGRESS",
      ],
    },
    { key: "serviceId", label: "Service ID", kind: "string", required: false },
    { key: "sourceType", label: "Source Type", kind: "string", required: false },
    { key: "cpu", label: "CPU", kind: "string", required: false },
    { key: "memory", label: "Memory", kind: "string", required: false },
  ],
  outputs: [
    { key: "serviceUrl", label: "Service URL", sensitive: false },
    { key: "serviceArn", label: "Service ARN", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "service",
  supportsCreate: true,
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "apprunner-url",
      displayName: "App Runner URL",
      description: "Service URL for HTTP access",
      entries: [{ envKey: "APP_RUNNER_URL", outputKey: "serviceUrl" }],
    },
  ],
};
