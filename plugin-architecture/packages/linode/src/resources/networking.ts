import { f, o, rt } from "@infrawrench/plugin-base";
import { REGION_IDS } from "../regions.js";

/** NodeBalancer (managed load balancer). `externalId` is the numeric id. */
export const NodeBalancerResourceType = rt({
  name: "NodeBalancer",
  id: "nodebalancer",
  description: "A Linode NodeBalancer (managed load balancer)",
  fields: [
    f("label", "Label"),
    f("region", "Region", { kind: "enum", enumValues: REGION_IDS, editable: false }),
    f("nbType", "Tier", { required: false, editable: false }),
    f("hostname", "Hostname", { required: false, editable: false }),
    f("ipv4", "IPv4", { required: false, editable: false }),
    f("ipv6", "IPv6", { required: false, editable: false }),
    f("clientConnThrottle", "Connection Throttle", {
      kind: "number",
      required: false,
      description:
        "New TCP connections per second allowed from one client IP (0 to 20; 0 disables)",
    }),
    f("configCount", "Ports", { kind: "number", required: false, editable: false }),
    f("nodeCount", "Backend Nodes", { kind: "number", required: false, editable: false }),
    f("nodesUp", "Nodes Up", { kind: "number", required: false, editable: false }),
    f("nodesDown", "Nodes Down", { kind: "number", required: false, editable: false }),
    f("transferMb", "Transfer This Month (MB)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("lkeClusterId", "Kubernetes Cluster", { required: false, editable: false }),
    f("firewallIds", "Firewalls", { required: false, editable: false }),
    f("tags", "Tags", { required: false }),
  ],
  outputs: [o("ipv4", "IPv4"), o("ipv6", "IPv6"), o("hostname", "Hostname")],
  dependsOn: [
    { fieldKey: "lkeClusterId", targetTypeId: "lke-cluster", label: "serves" },
    { fieldKey: "firewallIds", targetTypeId: "firewall", label: "protected by" },
  ],
  iconKey: "load-balancer",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  // `nodeCount` is always written by the lister (sum of up + down across
  // every port config), so "0" means a NodeBalancer with nothing behind it.
  orphanRule: {
    conditions: [{ fieldKey: "nodeCount", when: "equals", value: "0" }],
    reason: "NodeBalancer has no backend nodes, so it serves nothing but is still billed",
  },
  dnsServiceHosts: [
    {
      id: "linode-nodebalancer",
      label: "Linode NodeBalancer hostname",
      hostPattern: "(nb-[0-9-]+)\\.[a-z0-9-]+\\.nodebalancer\\.linode\\.com",
      labelIs: "opaque",
      hostKeys: ["hostname"],
      reason:
        "The record points at a NodeBalancer hostname that no synced NodeBalancer owns; the address behind it may now belong to someone else.",
    },
  ],
});

/** Cloud Firewall. `externalId` is the numeric id. */
export const FirewallResourceType = rt({
  name: "Firewall",
  id: "firewall",
  description: "A Linode Cloud Firewall",
  fields: [
    f("label", "Label"),
    f("status", "Status", {
      kind: "enum",
      required: false,
      enumValues: ["enabled", "disabled"],
      description: "A disabled firewall lets all traffic through",
    }),
    f("inboundPolicy", "Default Inbound", {
      kind: "enum",
      enumValues: ["ACCEPT", "DROP"],
      description: "What happens to inbound traffic no rule matches",
    }),
    f("outboundPolicy", "Default Outbound", {
      kind: "enum",
      enumValues: ["ACCEPT", "DROP"],
      description: "What happens to outbound traffic no rule matches",
    }),
    f("inboundRuleCount", "Inbound Rules", { kind: "number", required: false, editable: false }),
    f("outboundRuleCount", "Outbound Rules", { kind: "number", required: false, editable: false }),
    f("deviceCount", "Devices", { kind: "number", required: false, editable: false }),
    f("devices", "Protects", { required: false, editable: false }),
    f("tags", "Tags", { required: false }),
  ],
  outputs: [o("firewallId", "Firewall ID")],
  iconKey: "firewall",
  supportsCreate: true,
  supportsUpdate: true,
  attachTargets: [
    { pluginId: "linode", resourceTypeId: "linode", verb: "Protect" },
    { pluginId: "linode", resourceTypeId: "nodebalancer", verb: "Protect" },
  ],
  postureChecks: [
    {
      id: "linode-firewall-accepts-all-inbound",
      title: "Firewall accepts all inbound traffic by default",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "inboundPolicy", when: "equals", value: "ACCEPT" }],
      reason:
        "The default inbound policy is ACCEPT, so any port not explicitly dropped is open to the internet.",
    },
  ],
});

/** VPC. `externalId` is the numeric id. */
export const VpcResourceType = rt({
  name: "VPC",
  plural: "VPCs",
  id: "vpc",
  description: "A Linode Virtual Private Cloud",
  fields: [
    f("label", "Label"),
    f("region", "Region", { kind: "enum", enumValues: REGION_IDS, editable: false }),
    f("description", "Description", { required: false }),
    f("subnetCount", "Subnets", { kind: "number", required: false, editable: false }),
    f("subnets", "Subnet Ranges", { required: false, editable: false }),
    f("linodeCount", "Attached Linodes", { kind: "number", required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [o("vpcId", "VPC ID")],
  iconKey: "network",
  supportsCreate: true,
  supportsUpdate: true,
});

/**
 * Reserved IPv4 address (GA 2026-07-01). The address is the identifier: every
 * endpoint is `/networking/reserved/ips/{address}`. Billed at a flat rate
 * whether or not it is assigned, which is what makes an unassigned one waste.
 */
export const ReservedIpResourceType = rt({
  name: "Reserved IP",
  id: "reserved-ip",
  description: "A reserved public IPv4 address",
  fields: [
    f("address", "Address", { editable: false }),
    f("region", "Region", { kind: "enum", enumValues: REGION_IDS, editable: false }),
    f("assignedEntityId", "Assigned To", {
      required: false,
      editable: false,
      description: "ID of the Linode or NodeBalancer using the address; empty when unassigned",
    }),
    f("assignedEntityType", "Assigned Type", { required: false, editable: false }),
    f("assignedEntityLabel", "Assigned Label", { required: false, editable: false }),
    f("rdns", "Reverse DNS", { required: false, editable: false }),
    f("tags", "Tags", { required: false }),
  ],
  outputs: [o("ip", "IP Address")],
  dependsOn: [{ fieldKey: "assignedEntityId", targetTypeId: "linode", label: "assigned to" }],
  iconKey: "ip",
  supportsCreate: true,
  supportsUpdate: true,
  orphanRule: {
    conditions: [{ fieldKey: "assignedEntityId", when: "equals", value: "" }],
    reason: "Reserved IP is not assigned to anything but is billed whether or not it is in use",
  },
  attachTargets: [
    { pluginId: "linode", resourceTypeId: "linode", matchField: "region", verb: "Assign" },
  ],
});

/** DNS Manager domain (zone). `externalId` is the numeric domain id. */
export const DomainResourceType = rt({
  name: "Domain",
  id: "domain",
  description: "A domain hosted on Linode DNS Manager",
  fields: [
    f("domain", "Domain", { editable: false }),
    f("type", "Type", {
      kind: "enum",
      enumValues: ["master", "slave"],
      editable: false,
      description: "master: Linode is authoritative. slave: Linode mirrors another nameserver",
    }),
    f("status", "Status", { kind: "enum", required: false, enumValues: ["active", "disabled"] }),
    f("soaEmail", "SOA Email", { required: false }),
    f("ttlSec", "Default TTL", { kind: "number", required: false }),
    f("masterIps", "Primary Nameserver IPs", {
      required: false,
      description: "Comma-separated; only used for slave domains",
    }),
    f("description", "Description", { required: false }),
    f("recordCount", "Records", { kind: "number", required: false, editable: false }),
    f("tags", "Tags", { required: false }),
  ],
  outputs: [o("nameservers", "Nameservers")],
  iconKey: "dns",
  supportsCreate: true,
  supportsUpdate: true,
  dnsRole: {
    role: "zone",
    domainKey: "domain",
    recordCountKey: "recordCount",
    statusKey: "status",
  },
});

/**
 * A record inside a DNS Manager domain. `externalId` is
 * `{domainId}/{recordId}`: every record endpoint needs both.
 */
export const DomainRecordResourceType = rt({
  name: "DNS Record",
  id: "domain-record",
  pinnable: false,
  description: "A DNS record in a Linode DNS Manager domain",
  fields: [
    f("type", "Type", {
      kind: "enum",
      enumValues: ["A", "AAAA", "NS", "MX", "CNAME", "TXT", "SRV", "PTR", "CAA"],
      editable: false,
    }),
    f("name", "Name", { required: false, description: "Relative to the domain; @ for the apex" }),
    f("target", "Target"),
    f("ttlSec", "TTL", { kind: "number", required: false }),
    f("priority", "Priority", { kind: "number", required: false }),
    f("weight", "Weight", { kind: "number", required: false }),
    f("port", "Port", { kind: "number", required: false }),
    f("service", "Service", { required: false }),
    f("protocol", "Protocol", { required: false }),
    f("tag", "CAA Tag", {
      kind: "enum",
      required: false,
      enumValues: ["issue", "issuewild", "iodef", ""],
    }),
    f("domainName", "Domain", { required: false, editable: false }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "domainName", targetTypeId: "domain", label: "in domain" }],
  parentTypeId: "domain",
  iconKey: "dns-record",
  supportsCreate: true,
  supportsUpdate: true,
  dnsRole: {
    role: "record",
    nameKey: "name",
    typeKey: "type",
    contentKey: "target",
    ttlKey: "ttlSec",
    priorityKey: "priority",
    zoneKey: "domainName",
  },
});
