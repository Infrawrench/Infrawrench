import { f, o, rt } from "@infrawrench/plugin-base";

export const SpectrumApplicationResourceType = rt({
  name: "Spectrum Application",
  pinnable: false,
  id: "spectrum-application",
  description: "A Cloudflare Spectrum application for TCP/UDP proxy",
  fields: [
    f("protocol", "Protocol", { editable: false }),
    f("dns", "DNS Name", { required: false, editable: false }),
    f("originDirect", "Origin Direct", { required: false }),
    f("originDns", "Origin DNS", { required: false, editable: false }),
    f("originPort", "Origin Port", { required: false, editable: false }),
    f("ipFirewall", "IP Firewall", { kind: "boolean", required: false }),
    f("proxyProtocol", "Proxy Protocol", { required: false }),
    f("tls", "TLS", { required: false }),
    f("createdOn", "Created", { required: false, editable: false }),
    f("modifiedOn", "Modified", { required: false, editable: false }),
  ],
  outputs: [],
  parentTypeId: "zone",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "spectrum",
});
