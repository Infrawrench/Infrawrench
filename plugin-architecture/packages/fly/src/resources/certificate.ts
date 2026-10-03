import { f, o, rt } from "@infrawrench/plugin-base";

export const CertificateResourceType = rt({
  name: "Certificate",
  id: "certificate",
  description: "A Fly.io TLS certificate for a custom app hostname",
  parentTypeId: "app",
  fields: [
    f("hostname", "Hostname"),
    f("appName", "App"),
    f("status", "Status", { required: false }),
    f("configured", "Configured", { kind: "boolean", required: false }),
    f("acmeDnsConfigured", "ACME DNS", { kind: "boolean", required: false }),
    f("acmeAlpnConfigured", "ACME TLS-ALPN", { kind: "boolean", required: false }),
    f("acmeHttpConfigured", "ACME HTTP", { kind: "boolean", required: false }),
    f("ownershipTxtConfigured", "Ownership TXT", { kind: "boolean", required: false }),
    f("source", "Source", {
      required: false,
      description: "fly (Let's Encrypt via ACME) or custom (uploaded certificate)",
    }),
    f("certificateAuthority", "Authority", { required: false }),
    f("expires", "Expires", { required: false }),
    f("dnsProvider", "DNS Provider", { required: false }),
    f("validationErrors", "Validation Errors", { required: false }),
  ],
  outputs: [o("hostname", "Hostname")],
  dependsOn: [{ fieldKey: "appName", targetTypeId: "app", label: "in app" }],
  expiryFields: [
    { fieldKey: "expires", from: "expiry", kind: "tls-cert", label: "Certificate expires" },
  ],
  iconKey: "certificate",
  supportsCreate: true,
});
