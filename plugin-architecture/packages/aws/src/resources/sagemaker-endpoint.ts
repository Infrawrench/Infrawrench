import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SageMakerEndpointResourceType: ResourceTypeDefinition = {
  id: "sagemaker-endpoint",
  displayName: "SageMaker Endpoint",
  pluralDisplayName: "SageMaker Endpoints",
  description: "An Amazon SageMaker ML inference endpoint",
  fields: [
    { key: "endpointName", label: "Endpoint Name", kind: "string", required: true },
    {
      key: "status",
      label: "Status",
      kind: "enum",
      required: true,
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
    },
    { key: "endpointConfigName", label: "Config Name", kind: "string", required: false },
    { key: "creationTime", label: "Created", kind: "string", required: false },
    { key: "lastModifiedTime", label: "Last Modified", kind: "string", required: false },
  ],
  outputs: [{ key: "endpointArn", label: "Endpoint ARN", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "function",
  supportsMetrics: true,
};
