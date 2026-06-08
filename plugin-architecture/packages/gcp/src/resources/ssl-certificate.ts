import { f, o, rt } from "@infrawrench/plugin-base";

export const SslCertificateResourceType = rt({
  name: "SSL Certificate",
  pinnable: false,
  id: "ssl-certificate",
  description: "A Google Cloud managed or self-managed SSL certificate",
  fields: [
    f("name", "Name"),
    f("type", "Type", { required: false }),
    f("status", "Status", { required: false }),
    f("domains", "Domains", { required: false }),
    f("expireTime", "Expires", { required: false }),
  ],
  outputs: [o("dnsRecords", "DNS Records"), o("domains", "Domains")],
  supportsCreate: true,
});
