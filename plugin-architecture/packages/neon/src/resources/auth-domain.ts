import { f, rt } from "@infrawrench/plugin-base";

export const NeonAuthDomainResourceType = rt({
  name: "Trusted Domain",
  plural: "Trusted Domains",
  id: "neon-auth-domain",
  description: "A domain allowed as a Neon Auth redirect URI target",
  fields: [
    f("domain", "Domain"),
    // Carried because Neon's delete-domain call requires the owning auth provider.
    f("authProvider", "Provider", { required: false }),
    f("projectId", "Project ID"),
    f("branchId", "Branch ID"),
  ],
  outputs: [],
  parentTypeId: "neon-auth",
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "dns",
});
