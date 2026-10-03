import { f, o, rt } from "@infrawrench/plugin-base";
import { LAMBDA_RUNTIME_IDS } from "../constants.js";

export const LambdaFunctionResourceType = rt({
  name: "Lambda Function",
  id: "lambda-function",
  description: "An AWS Lambda serverless function",
  // Edit = UpdateFunctionConfiguration. Only the settings it accepts without
  // a new deployment package are editable; the architecture and package type
  // are fixed by the code that was uploaded.
  fields: [
    f("name", "Function Name", { editable: false }),
    f("runtime", "Runtime", {
      required: false,
      kind: "enum",
      enumValues: LAMBDA_RUNTIME_IDS,
      description:
        "Managed runtime identifier. Switch within the same language family only: the handler and deployment package are left as they are",
    }),
    f("handler", "Handler", { required: false, editable: false }),
    f("architecture", "Architecture", {
      required: false,
      editable: false,
      kind: "enum",
      enumValues: ["x86_64", "arm64"],
    }),
    f("packageType", "Package Type", {
      required: false,
      editable: false,
      kind: "enum",
      enumValues: ["Zip", "Image"],
    }),
    f("codeSize", "Code Size", { kind: "number", required: false, editable: false }),
    f("memorySize", "Memory (MB)", {
      kind: "number",
      required: false,
      description: "128 to 32768 MB. CPU is allocated in proportion to memory",
    }),
    f("timeout", "Timeout (s)", {
      kind: "number",
      required: false,
      description: "1 to 900 seconds",
    }),
    f("ephemeralStorageMb", "Ephemeral Storage (MB)", {
      kind: "number",
      required: false,
      description: "Size of /tmp, 512 to 10240 MB",
    }),
    f("logFormat", "Log Format", {
      kind: "enum",
      required: false,
      enumValues: ["Text", "JSON"],
      description: "Format Lambda writes application and system logs in",
    }),
    f("applicationLogLevel", "Application Log Level", {
      kind: "enum",
      required: false,
      enumValues: ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"],
      description: "Filters application logs. Only applies when the log format is JSON",
    }),
    f("systemLogLevel", "System Log Level", {
      kind: "enum",
      required: false,
      enumValues: ["DEBUG", "INFO", "WARN"],
      description: "Filters Lambda's own platform logs. Only applies when the log format is JSON",
    }),
    f("logGroup", "Log Group", {
      required: false,
      editable: false,
      description: "CloudWatch log group the function writes to",
    }),
    f("snapStart", "SnapStart", {
      required: false,
      editable: false,
      description: "SnapStart setting (PublishedVersions or None)",
    }),
    f("capacityProviderArn", "Capacity Provider", {
      required: false,
      editable: false,
      description: "Set when the function runs on Lambda Managed Instances",
    }),
    f("durableExecution", "Durable Execution", {
      kind: "boolean",
      required: false,
      editable: false,
      description: "Whether the function is configured as a durable function",
    }),
    f("state", "State", { required: false, editable: false }),
    f("lastModified", "Last Modified", { required: false, editable: false }),
    f("roleArn", "Execution Role", { required: false, editable: false }),
    f("vpcId", "VPC ID", {
      required: false,
      editable: false,
      description: "Set when the function is VPC-attached",
    }),
    f("subnetIds", "Subnets", {
      required: false,
      editable: false,
      description: "Comma-separated subnet IDs the function's ENIs live in",
    }),
    f("securityGroupIds", "Security Groups", {
      required: false,
      editable: false,
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
    { fieldKey: "logGroup", targetTypeId: "cloudwatch-log-group", label: "logs to" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
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
