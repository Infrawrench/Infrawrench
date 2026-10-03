import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A WorkOS organization: the tenant container that owns memberships,
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
    f("externalId", "External ID", {
      required: false,
      description: "Your own identifier for this organization. Leave blank to clear it.",
    }),
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
  // Admin Portal links are short-lived setup URLs for the organization's IT
  // admin; the reveal-once credential flow is the host's way to hand over a
  // freshly minted, sensitive value.
  credentialFormats: [
    {
      id: "portal-sso",
      label: "Admin Portal link: SSO setup",
      description:
        "A link the organization's IT admin opens to configure Single Sign-On. Expires after five minutes.",
      mediaType: "text",
    },
    {
      id: "portal-dsync",
      label: "Admin Portal link: Directory Sync setup",
      description:
        "A link for connecting the organization's directory (SCIM, Google Workspace, HRIS).",
      mediaType: "text",
    },
    {
      id: "portal-domain_verification",
      label: "Admin Portal link: domain verification",
      description: "A link for verifying the organization's domains.",
      mediaType: "text",
    },
    {
      id: "portal-certificate_renewal",
      label: "Admin Portal link: SAML certificate renewal",
      description: "A link for uploading a renewed SAML signing certificate.",
      mediaType: "text",
    },
    {
      id: "portal-audit_logs",
      label: "Admin Portal link: Audit Logs",
      description: "A link for viewing and exporting the organization's audit logs.",
      mediaType: "text",
    },
    {
      id: "portal-log_streams",
      label: "Admin Portal link: Log Streams",
      description: "A link for streaming audit logs to the organization's SIEM.",
      mediaType: "text",
    },
    {
      id: "portal-bring_your_own_key",
      label: "Admin Portal link: Bring Your Own Key",
      description: "A link for configuring the organization's own encryption key for Vault.",
      mediaType: "text",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "organization",
});
