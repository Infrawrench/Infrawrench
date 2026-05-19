import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CognitoUserPoolResourceType: ResourceTypeDefinition = {
  id: "cognito-user-pool",
  displayName: "Cognito User Pool",
  pluralDisplayName: "Cognito User Pools",
  description: "An Amazon Cognito user pool for application user authentication",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "userPoolId", label: "User Pool ID", kind: "string", required: true },
    {
      key: "status",
      label: "Status",
      kind: "enum",
      required: false,
      enumValues: ["Enabled", "Disabled"],
    },
    {
      key: "mfaConfiguration",
      label: "MFA",
      kind: "enum",
      required: false,
      enumValues: ["OFF", "ON", "OPTIONAL"],
    },
    { key: "estimatedNumberOfUsers", label: "Users", kind: "number", required: false },
    { key: "creationDate", label: "Created", kind: "string", required: false },
    { key: "lastModifiedDate", label: "Last Modified", kind: "string", required: false },
    { key: "domain", label: "Domain", kind: "string", required: false },
  ],
  outputs: [
    { key: "userPoolId", label: "User Pool ID", sensitive: false },
    { key: "userPoolArn", label: "User Pool ARN", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "users",
  secretExportTemplates: [
    {
      id: "user-pool",
      displayName: "User Pool",
      description: "User pool identifiers for Cognito SDK / IdP integration",
      entries: [
        { envKey: "COGNITO_USER_POOL_ID", outputKey: "userPoolId" },
        { envKey: "COGNITO_USER_POOL_ARN", outputKey: "userPoolArn" },
      ],
    },
  ],
};
