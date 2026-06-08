import { f, o, rt } from "@infrawrench/plugin-base";

export const CognitoUserPoolResourceType = rt({
  name: "Cognito User Pool",
  id: "cognito-user-pool",
  description: "An Amazon Cognito user pool for application user authentication",
  fields: [
    f("name", "Name"),
    f("userPoolId", "User Pool ID"),
    f("status", "Status", { kind: "enum", required: false, enumValues: ["Enabled", "Disabled"] }),
    f("mfaConfiguration", "MFA", {
      kind: "enum",
      required: false,
      enumValues: ["OFF", "ON", "OPTIONAL"],
    }),
    f("estimatedNumberOfUsers", "Users", { kind: "number", required: false }),
    f("creationDate", "Created", { required: false }),
    f("lastModifiedDate", "Last Modified", { required: false }),
    f("domain", "Domain", { required: false }),
  ],
  outputs: [o("userPoolId", "User Pool ID"), o("userPoolArn", "User Pool ARN")],
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
});
