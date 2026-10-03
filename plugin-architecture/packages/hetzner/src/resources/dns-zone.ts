import { f, o, rt } from "@infrawrench/plugin-base";

export const DnsZoneResourceType = rt({
  name: "DNS Zone",
  id: "dns-zone",
  description: "A DNS zone hosted on Hetzner DNS (part of the Cloud API since November 2025)",
  fields: [
    f("name", "Domain", { editable: false }),
    f("mode", "Mode", { kind: "enum", enumValues: ["primary", "secondary"], editable: false }),
    f("ttl", "Default TTL", {
      kind: "number",
      description: "Default TTL in seconds for records without their own (60 or more)",
    }),
    f("status", "Status", {
      kind: "enum",
      required: false,
      enumValues: ["ok", "updating", "error"],
      editable: false,
    }),
    f("recordCount", "Records", { kind: "number", required: false, editable: false }),
    f("registrar", "Registrar", {
      kind: "enum",
      required: false,
      enumValues: ["hetzner", "other", "unknown"],
      editable: false,
    }),
    f("delegationStatus", "Delegation", {
      kind: "enum",
      required: false,
      enumValues: ["valid", "partially-valid", "invalid", "lame", "unregistered", "unknown"],
      description: "Whether the domain's registrar delegates to the assigned Hetzner nameservers",
      editable: false,
    }),
    f("nameservers", "Nameservers", {
      required: false,
      description: "Hetzner nameservers assigned to this zone",
      editable: false,
    }),
    f("deleteProtection", "Delete Protection", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
  ],
  outputs: [o("nameservers", "Nameservers"), o("zoneId", "Zone ID")],
  supportsCreate: true,
  // Edit = default TTL (`actions/change_ttl`); a zone cannot be renamed.
  supportsUpdate: true,
  iconKey: "dns",
  dnsRole: { role: "zone", domainKey: "name", recordCountKey: "recordCount", statusKey: "status" },
  postureChecks: [
    {
      id: "hetzner-dns-zone-not-delegated",
      title: "Zone not delegated to Hetzner",
      severity: "low",
      category: "other",
      conditions: [{ fieldKey: "delegationStatus", when: "equals", value: "invalid" }],
      reason:
        "The domain's registrar does not point at the nameservers Hetzner assigned, so the records in this zone are not what the internet resolves.",
    },
  ],
});
