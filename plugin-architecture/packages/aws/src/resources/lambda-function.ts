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
  ],
  outputs: [o("functionArn", "Function ARN")],
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
