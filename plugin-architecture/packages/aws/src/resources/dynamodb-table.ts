import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DynamoDBTableResourceType: ResourceTypeDefinition = {
  id: "dynamodb-table",
  displayName: "DynamoDB Table",
  pluralDisplayName: "DynamoDB Tables",
  description: "An Amazon DynamoDB NoSQL table",
  fields: [
    { key: "tableName", label: "Table Name", kind: "string", required: true },
    { key: "status", label: "Status", kind: "string", required: true },
    { key: "itemCount", label: "Item Count", kind: "number", required: false },
    { key: "sizeBytes", label: "Size (Bytes)", kind: "number", required: false },
    { key: "billingMode", label: "Billing Mode", kind: "string", required: false },
    { key: "partitionKey", label: "Partition Key", kind: "string", required: false },
    { key: "sortKey", label: "Sort Key", kind: "string", required: false },
  ],
  outputs: [{ key: "tableArn", label: "Table ARN", sensitive: false }],
  dashboardPinnable: true,
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
};
