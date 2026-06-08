import { f, o, rt } from "@infrawrench/plugin-base";

export const SSLCertificateResourceType = rt({
  name: "SSL Certificate",
  pinnable: false,
  id: "ssl-certificate",
  description: "An SSL/TLS certificate managed by Cloudflare",
  fields: [
    f("hosts", "Hosts"),
    f("issuer", "Issuer", { required: false }),
    f("status", "Status"),
    f("type", "Type", { required: false }),
    f("expiresOn", "Expires", { required: false }),
    f("zoneName", "Zone", { required: false }),
  ],
  outputs: [],
  parentTypeId: "zone",
  supportsCreate: true,
  iconKey: "certificate",
});
