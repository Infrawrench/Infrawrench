import { f, rt } from "@infrawrench/plugin-base";

export const CustomHostnameResourceType = rt({
  name: "Custom Hostname",
  pinnable: false,
  id: "custom-hostname",
  description: "A custom hostname (SSL for SaaS) on a Cloudflare zone",
  fields: [
    f("hostname", "Hostname", { editable: false }),
    f("status", "Status", { editable: false }),
    f("sslStatus", "SSL Status", { required: false, editable: false }),
    f("sslMethod", "SSL Method", { required: false }),
    f("sslType", "SSL Type", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("zoneName", "Zone", { required: false, editable: false }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "zoneName", targetTypeId: "zone", targetKey: "name", label: "in zone" }],
  parentTypeId: "zone",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "hostname",
});
