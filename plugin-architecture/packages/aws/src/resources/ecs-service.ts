import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ECSServiceResourceType: ResourceTypeDefinition = {
  id: "ecs-service",
  displayName: "ECS Service",
  pluralDisplayName: "ECS Services",
  description: "An Amazon ECS service running on a cluster",
  fields: [
    { key: "serviceName", label: "Service Name", kind: "string", required: true },
    { key: "clusterName", label: "Cluster", kind: "string", required: true },
    { key: "status", label: "Status", kind: "string", required: true },
    {
      key: "launchType",
      label: "Launch Type",
      kind: "enum",
      required: false,
      enumValues: ["FARGATE", "EC2", "EXTERNAL"],
    },
    { key: "desiredCount", label: "Desired Count", kind: "number", required: false },
    { key: "runningCount", label: "Running Count", kind: "number", required: false },
    { key: "taskDefinition", label: "Task Definition", kind: "string", required: false },
  ],
  outputs: [{ key: "serviceArn", label: "Service ARN", sensitive: false }],
  dashboardPinnable: true,
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "container",
};
