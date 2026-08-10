import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Scoped credentials are the auth substrate for Neon's branch-scoped services
 * (Object Storage, Functions, AI Gateway). The API returns the token and S3
 * secret exactly once, at creation — there is no endpoint to read them back,
 * so both outputs resolve only from the create response.
 */
export const NeonCredentialResourceType = rt({
  name: "Credential",
  plural: "Credentials",
  id: "neon-credential",
  description:
    "A scoped credential for a Neon branch's Storage, Functions, and AI Gateway services",
  fields: [
    f("name", "Name", { required: false }),
    f("tokenIdShort", "Token ID"),
    f("scopes", "Scopes"),
    f("projectId", "Project ID"),
    f("branchId", "Branch ID"),
    f("createdAt", "Created At", { required: false }),
    f("lastUsedAt", "Last Used", { required: false }),
    f("expiresAt", "Expires At", { required: false }),
  ],
  outputs: [
    o("apiToken", "API Token", { sensitive: true }),
    o("s3SecretAccessKey", "S3 Secret Access Key", { sensitive: true }),
    o("tokenId", "Token ID"),
  ],
  dependsOn: [
    { fieldKey: "projectId", targetTypeId: "neon-project", label: "in project" },
    { fieldKey: "branchId", targetTypeId: "neon-branch", label: "on branch" },
  ],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "Credential expires" },
  ],
  parentTypeId: "neon-branch",
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "key",
  secretExportTemplates: [
    {
      id: "s3-credentials",
      displayName: "S3 Credentials",
      description:
        "AWS-style keys for Neon Object Storage. Only available on the credential you just created — Neon returns these once.",
      entries: [
        { envKey: "AWS_ACCESS_KEY_ID", outputKey: "apiToken" },
        { envKey: "AWS_SECRET_ACCESS_KEY", outputKey: "s3SecretAccessKey" },
      ],
    },
  ],
});
