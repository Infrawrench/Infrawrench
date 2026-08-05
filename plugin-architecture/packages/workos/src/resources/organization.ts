import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A WorkOS organization — the tenant container that owns memberships,
 * invitations, SSO connections and Directory Sync directories.
 * Docs: https://workos.com/docs/reference/organization
 */
export const OrganizationResourceType = rt({
  name: "Organization",
  id: "organization",
  description:
    "A WorkOS organization. The tenant container for organization memberships, invitations, SSO connections and Directory Sync directories.",
  fields: [
    f("name", "Name"),
    f("organizationId", "Organization ID", { required: false, editable: false }),
    f("externalId", "External ID", { required: false, editable: false }),
    f("domains", "Domains", {
      required: false,
      editable: false,
      description: "Verified and pending organization domains, comma-separated.",
    }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("organizationId", "Organization ID", {
      description: "The org_… id used in every organization-scoped API call.",
    }),
    o("organizationName", "Organization Name"),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "organization",
});
