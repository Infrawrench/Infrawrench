import { f, o, rt } from "@infrawrench/plugin-base";

export const SslCertificateResourceType = rt({
  name: "SSL Certificate",
  pinnable: false,
  id: "ssl-certificate",
  iconKey: "certificate",
  description: "A Google Cloud managed or self-managed SSL certificate",
  fields: [
    f("name", "Name"),
    f("type", "Type", { showcase: true, required: false }),
    f("status", "Status", { showcase: true, required: false }),
    f("domains", "Domains", { required: false }),
    f("expireTime", "Expires", { showcase: true, required: false }),
  ],
  outputs: [o("dnsRecords", "DNS Records"), o("domains", "Domains")],
  expiryFields: [
    { fieldKey: "expireTime", from: "expiry", kind: "tls-cert", label: "Certificate expires" },
  ],
  supportsCreate: true,
});
