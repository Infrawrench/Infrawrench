import { f, o, rt } from "@infrawrench/plugin-base";

export const SageMakerEndpointResourceType = rt({
  name: "SageMaker Endpoint",
  id: "sagemaker-endpoint",
  description: "An Amazon SageMaker ML inference endpoint",
  fields: [
    f("endpointName", "Endpoint Name"),
    f("status", "Status", {
      kind: "enum",
      enumValues: [
        "OutOfService",
        "Creating",
        "Updating",
        "SystemUpdating",
        "RollingBack",
        "InService",
        "Deleting",
        "Failed",
        "UpdateRollbackFailed",
      ],
    }),
    f("endpointConfigName", "Config Name", { required: false }),
    f("creationTime", "Created", { required: false }),
    f("lastModifiedTime", "Last Modified", { required: false }),
  ],
  outputs: [o("endpointArn", "Endpoint ARN")],
  iconKey: "function",
  supportsMetrics: true,
});
