import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SpectrumApplicationResourceType: ResourceTypeDefinition = {
  id: "spectrum-application",
  displayName: "Spectrum Application",
  pluralDisplayName: "Spectrum Applications",
  description: "A Cloudflare Spectrum application for TCP/UDP proxy",
  fields: [
    { key: "protocol", label: "Protocol", kind: "string", required: true },
    { key: "dns", label: "DNS Name", kind: "string", required: false },
    { key: "originDirect", label: "Origin Direct", kind: "string", required: false },
    { key: "originDns", label: "Origin DNS", kind: "string", required: false },
    { key: "originPort", label: "Origin Port", kind: "string", required: false },
    { key: "ipFirewall", label: "IP Firewall", kind: "boolean", required: false },
    { key: "proxyProtocol", label: "Proxy Protocol", kind: "string", required: false },
    { key: "tls", label: "TLS", kind: "string", required: false },
    { key: "createdOn", label: "Created", kind: "string", required: false },
    { key: "modifiedOn", label: "Modified", kind: "string", required: false },
  ],
  outputs: [],
  parentTypeId: "zone",
  dashboardPinnable: false,
  iconKey: "spectrum",
};
