import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An SSO connection between an organization and its identity provider.
 * Connections are configured through the WorkOS dashboard or Admin Portal;
 * the API can list, inspect, rename and delete them.
 * Docs: https://workos.com/docs/reference/sso/connection
 */
export const ConnectionResourceType = rt({
  name: "SSO Connection",
  id: "connection",
  description:
    "A Single Sign-On connection between an organization and its identity provider (Okta SAML, Azure SAML, Google OAuth, generic OIDC, …). Configured via the dashboard or an Admin Portal link; renamable and deletable here.",
  fields: [
    f("name", "Name"),
    f("connectionType", "Type", { required: false, editable: false }),
    f("state", "State", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["requires_type", "draft", "active", "validating", "inactive", "deleting"],
    }),
    f("domains", "Domains", { required: false, editable: false }),
    f("organizationId", "Organization ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("connectionId", "Connection ID")],
  parentTypeId: "organization",
  showInSidebar: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "sso",
});
