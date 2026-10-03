import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A domain claimed by an organization. Domains drive SSO routing and AuthKit
 * domain capture, and are verified with a DNS TXT record.
 * Docs: https://workos.com/docs/reference/domain-verification
 */
export const OrganizationDomainResourceType = rt({
  name: "Organization Domain",
  id: "organization-domain",
  description:
    "A domain claimed by an organization. Add one here, publish the TXT record it shows, then verify it.",
  fields: [
    f("domain", "Domain", { editable: false }),
    f("state", "State", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["pending", "verified", "failed", "unverified", "legacy_verified"],
    }),
    f("verificationStrategy", "Verification", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["dns", "manual"],
    }),
    f("txtRecordName", "TXT record name", { required: false, editable: false }),
    f("txtRecordValue", "TXT record value", { required: false, editable: false }),
    f("organizationId", "Organization ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("domainId", "Domain ID"),
    o("txtRecordName", "TXT record name"),
    o("txtRecordValue", "TXT record value"),
  ],
  parentTypeId: "organization",
  pinnable: false,
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "domain",
});
