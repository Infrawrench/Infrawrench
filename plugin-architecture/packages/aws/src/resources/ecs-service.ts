import { f, o, rt } from "@infrawrench/plugin-base";

export const ECSServiceResourceType = rt({
  name: "ECS Service",
  id: "ecs-service",
  description: "An Amazon ECS service running on a cluster",
  fields: [
    f("serviceName", "Service Name"),
    f("clusterName", "Cluster"),
    f("status", "Status"),
    f("launchType", "Launch Type", {
      kind: "enum",
      required: false,
      enumValues: ["FARGATE", "EC2", "EXTERNAL"],
    }),
    f("desiredCount", "Desired Count", { kind: "number", required: false }),
    f("runningCount", "Running Count", { kind: "number", required: false }),
    f("taskDefinition", "Task Definition", { required: false }),
  ],
  outputs: [o("serviceArn", "Service ARN")],
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "container",
});
