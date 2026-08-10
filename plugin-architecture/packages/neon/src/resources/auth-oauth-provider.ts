import { f, rt } from "@infrawrench/plugin-base";

export const NeonAuthOauthProviderResourceType = rt({
  name: "OAuth Provider",
  plural: "OAuth Providers",
  id: "neon-auth-oauth-provider",
  description: "An OAuth sign-in provider configured on a branch's Neon Auth",
  fields: [
    f("providerId", "Provider", {
      kind: "enum",
      enumValues: ["google", "github", "microsoft", "vercel"],
    }),
    f("type", "Type", { kind: "enum", enumValues: ["standard", "shared"], required: false }),
    f("clientId", "Client ID", { required: false }),
    f("projectId", "Project ID"),
    f("branchId", "Branch ID"),
  ],
  outputs: [],
  dependsOn: [
    { fieldKey: "projectId", targetTypeId: "neon-project", label: "in project" },
    { fieldKey: "branchId", targetTypeId: "neon-branch", label: "on branch" },
  ],
  parentTypeId: "neon-auth",
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "key",
});
