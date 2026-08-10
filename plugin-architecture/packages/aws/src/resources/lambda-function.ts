import { f, o, rt } from "@infrawrench/plugin-base";

export const LambdaFunctionResourceType = rt({
  name: "Lambda Function",
  id: "lambda-function",
  description: "An AWS Lambda serverless function",
  fields: [
    f("name", "Function Name"),
    f("runtime", "Runtime", { required: false }),
    f("handler", "Handler", { required: false }),
    f("codeSize", "Code Size", { kind: "number", required: false }),
    f("memorySize", "Memory (MB)", { kind: "number", required: false }),
    f("timeout", "Timeout (s)", { kind: "number", required: false }),
    f("state", "State", { required: false }),
    f("lastModified", "Last Modified", { required: false }),
    f("roleArn", "Execution Role", { required: false }),
    f("vpcId", "VPC ID", { required: false, description: "Set when the function is VPC-attached" }),
    f("subnetIds", "Subnets", {
      required: false,
      description: "Comma-separated subnet IDs the function's ENIs live in",
    }),
    f("securityGroupIds", "Security Groups", {
      required: false,
      description: "Comma-separated security group IDs applied to the function's ENIs",
    }),
  ],
  outputs: [o("functionArn", "Function ARN")],
  // Lambda stores the execution role as a full ARN while an IAM role's external
  // id is the bare role name, so match the role's `roleArn` output.
  dependsOn: [
    { fieldKey: "roleArn", targetTypeId: "iam-role", targetKey: "roleArn", label: "runs as" },
    { fieldKey: "vpcId", targetTypeId: "vpc", label: "in VPC" },
    { fieldKey: "subnetIds", targetTypeId: "subnet", label: "in subnet" },
    { fieldKey: "securityGroupIds", targetTypeId: "security-group", label: "guarded by" },
  ],
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "function",
  secretExportTemplates: [
    {
      id: "lambda-invoke",
      displayName: "Lambda Function ARN",
      description: "ARN for invoking this Lambda function",
      entries: [
        { envKey: "LAMBDA_FUNCTION_ARN", outputKey: "functionArn", description: "Function ARN" },
      ],
    },
  ],
});
