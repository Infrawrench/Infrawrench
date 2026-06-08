import { f, o, rt } from "@infrawrench/plugin-base";

export const CertificateResourceType = rt({
  name: "Certificate",
  id: "certificate",
  description: "A Fly.io TLS certificate for a custom app hostname",
  parentTypeId: "app",
  fields: [
    f("hostname", "Hostname"),
    f("appName", "App"),
    f("configured", "Configured", { kind: "boolean", required: false }),
    f("acmeDnsConfigured", "ACME DNS", { kind: "boolean", required: false }),
    f("certificateAuthority", "Authority", { required: false }),
    f("issued", "Issued", { required: false }),
    f("expires", "Expires", { required: false }),
    f("dnsProvider", "DNS Provider", { required: false }),
  ],
  outputs: [o("hostname", "Hostname")],
  iconKey: "certificate",
  supportsCreate: true,
});
