import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A DigitalOcean TLS certificate (`/v2/certificates`): either a Let's Encrypt
 * certificate DO issues and renews for a domain it hosts DNS for, or a custom
 * certificate the user uploaded. Load balancers and CDN endpoints reference
 * these by id.
 */
export const CertificateResourceType = rt({
  name: "Certificate",
  id: "certificate",
  description: "A TLS certificate for DigitalOcean load balancers and CDN endpoints.",
  fields: [
    f("name", "Name"),
    f("type", "Type", {
      kind: "enum",
      required: false,
      enumValues: ["lets_encrypt", "custom"],
    }),
    f("state", "State", { required: false }),
    f("dnsNames", "Domains", {
      required: false,
      description: "Comma-separated names the certificate covers.",
    }),
    f("notAfter", "Expires", { required: false }),
    f("sha1Fingerprint", "SHA-1 Fingerprint", { required: false }),
    f("createdAt", "Created At", { required: false }),
  ],
  outputs: [o("certificateId", "Certificate ID")],
  showInSidebar: true,
  supportsCreate: true,
  iconKey: "certificate",
  // Let's Encrypt certificates renew automatically, but a custom upload does
  // not, and a Let's Encrypt renewal fails silently once the domain's DNS
  // moves off DigitalOcean.
  expiryFields: [
    { fieldKey: "notAfter", from: "expiry", kind: "tls-cert", label: "Certificate expires" },
  ],
});
