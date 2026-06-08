import { f, o, rt } from "@infrawrench/plugin-base";

export const AppRunnerServiceResourceType = rt({
  name: "App Runner Service",
  id: "apprunner-service",
  description: "An AWS App Runner service",
  fields: [
    f("serviceName", "Name"),
    f("status", "Status", {
      kind: "enum",
      enumValues: [
        "CREATE_FAILED",
        "RUNNING",
        "DELETED",
        "DELETE_FAILED",
        "PAUSED",
        "OPERATION_IN_PROGRESS",
      ],
    }),
    f("serviceId", "Service ID", { required: false }),
    f("sourceType", "Source Type", { required: false }),
    f("cpu", "CPU", { required: false }),
    f("memory", "Memory", { required: false }),
  ],
  outputs: [o("serviceUrl", "Service URL"), o("serviceArn", "Service ARN")],
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
});
