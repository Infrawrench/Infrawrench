import { f, o, rt } from "@infrawrench/plugin-base";

export const ECSServiceResourceType = rt({
  name: "ECS Service",
  id: "ecs-service",
  description: "An Amazon ECS service running on a cluster",
  // Only Fargate services are self-contained; an EC2-backed service runs on
  // instances that are counted as `ec2-instance` already.
  equivalence: [
    {
      category: "container-app",
      when: { fieldKey: "launchType", oneOf: ["FARGATE"] },
      createFields: { launchType: "FARGATE" },
    },
  ],
  fields: [
    f("serviceName", "Service Name"),
    f("clusterName", "Cluster"),
    f("region", "Region", { required: false, editable: false, sizing: "region" }),
    f("status", "Status", { showcase: true }),
    f("launchType", "Launch Type", {
      kind: "enum",
      required: false,
      enumValues: ["FARGATE", "EC2", "EXTERNAL"],
    }),
    f("desiredCount", "Desired Count", {
      showcase: true,
      kind: "number",
      required: false,
      sizing: "node-count",
    }),
    f("runningCount", "Running Count", { showcase: true, kind: "number", required: false }),
    f("taskDefinition", "Task Definition", { required: false }),
  ],
  outputs: [o("serviceArn", "Service ARN")],
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "container",
});
