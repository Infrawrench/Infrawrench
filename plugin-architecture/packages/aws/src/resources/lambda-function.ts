import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const LambdaFunctionResourceType: ResourceTypeDefinition = {
  id: "lambda-function",
  displayName: "Lambda Function",
  pluralDisplayName: "Lambda Functions",
  description: "An AWS Lambda serverless function",
  fields: [
    { key: "name", label: "Function Name", kind: "string", required: true },
    { key: "runtime", label: "Runtime", kind: "string", required: false },
    { key: "handler", label: "Handler", kind: "string", required: false },
    { key: "codeSize", label: "Code Size", kind: "number", required: false },
    { key: "memorySize", label: "Memory (MB)", kind: "number", required: false },
    { key: "timeout", label: "Timeout (s)", kind: "number", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "lastModified", label: "Last Modified", kind: "string", required: false },
  ],
  outputs: [{ key: "functionArn", label: "Function ARN", sensitive: false }],
  dashboardPinnable: true,
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
};
