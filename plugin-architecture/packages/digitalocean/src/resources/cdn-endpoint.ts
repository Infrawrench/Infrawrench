import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A DigitalOcean CDN endpoint (`/v2/cdn/endpoints`). The origin is always a
 * Spaces bucket's FQDN; a custom subdomain needs a DO-managed certificate.
 */
export const CdnEndpointResourceType = rt({
  name: "CDN Endpoint",
  id: "cdn-endpoint",
  description: "A DigitalOcean Spaces CDN endpoint.",
  fields: [
    f("origin", "Origin", {
      editable: false,
      description: "Spaces bucket hostname the CDN serves, e.g. assets.nyc3.digitaloceanspaces.com",
    }),
    f("endpoint", "CDN Hostname", { required: false, editable: false }),
    f("ttl", "Cache TTL (s)", {
      kind: "enum",
      required: false,
      enumValues: ["60", "600", "3600", "86400", "604800"],
      description: "How long edge servers cache content.",
    }),
    f("customDomain", "Custom Domain", {
      required: false,
      description: "Optional subdomain served by the CDN. Needs a certificate covering it.",
    }),
    f("certificateId", "Certificate", {
      required: false,
      description: "Certificate used for the custom domain.",
    }),
    f("createdAt", "Created At", { required: false, editable: false }),
  ],
  outputs: [o("endpoint", "CDN Hostname"), o("url", "CDN URL")],
  dependsOn: [{ fieldKey: "certificateId", targetTypeId: "certificate", label: "uses" }],
  showInSidebar: true,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "network",
});
