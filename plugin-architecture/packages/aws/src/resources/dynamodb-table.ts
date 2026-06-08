import { f, o, rt } from "@infrawrench/plugin-base";

export const DynamoDBTableResourceType = rt({
  name: "DynamoDB Table",
  id: "dynamodb-table",
  description: "An Amazon DynamoDB NoSQL table",
  fields: [
    f("tableName", "Table Name"),
    f("status", "Status"),
    f("itemCount", "Item Count", { kind: "number", required: false }),
    f("sizeBytes", "Size (Bytes)", { kind: "number", required: false }),
    f("billingMode", "Billing Mode", { required: false }),
    f("partitionKey", "Partition Key", { required: false }),
    f("sortKey", "Sort Key", { required: false }),
  ],
  outputs: [o("tableArn", "Table ARN")],
  iconKey: "database",
  supportsCreate: true,
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "dynamodb-table",
      displayName: "DynamoDB Table",
      description: "Table ARN for DynamoDB access",
      entries: [{ envKey: "DYNAMODB_TABLE_ARN", outputKey: "tableArn", description: "Table ARN" }],
    },
  ],
});
