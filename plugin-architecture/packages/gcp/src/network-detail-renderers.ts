/**
 * Detail renderers for VPC networking resources: Cloud Router, Cloud NAT,
 * and Backend Service.
 */
import type { DetailViewSchema, ResourceInstance, SectionNode } from "@infrawrench/plugin-base";

/** Apply the Cloud Router renderer to `base`. */
export function renderCloudRouter(resource: ResourceInstance, base: DetailViewSchema): void {
  base.subtitle = "Cloud Router";
  base.status = { kind: "status-dot", status: "healthy", label: "Active" };

  interface RouterAdvertisedRange {
    range?: string;
    description?: string;
  }
  interface RouterBgp {
    asn?: number;
    advertiseMode?: string;
    advertisedGroups?: string[];
    advertisedIpRanges?: RouterAdvertisedRange[];
  }
  interface RouterBgpPeer {
    name?: string;
    interfaceName?: string;
    importPolicies?: string[];
    exportPolicies?: string[];
  }
  interface RouterNat {
    name?: string;
  }
  interface RouterFull {
    bgp?: RouterBgp;
    bgpPeers?: RouterBgpPeer[];
    nats?: RouterNat[];
    error?: string;
  }
  interface RoutePolicy {
    name?: string;
    type?: string;
    terms?: unknown[];
  }
  interface RoutePoliciesResult {
    result?: RoutePolicy[];
    error?: string;
  }

  const parseJson = <T>(raw: unknown, fallback: T): T => {
    const s = String(raw ?? "");
    if (!s) return fallback;
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  };

  const full = parseJson<RouterFull>(resource.resolvedOutputs["cloudRouterFull"], {});
  const policiesData = parseJson<RoutePoliciesResult>(
    resource.resolvedOutputs["cloudRouterPolicies"],
    { result: [] },
  );

  const advertiseMode = String(full.bgp?.advertiseMode ?? "DEFAULT");
  const advertisedGroups = full.bgp?.advertisedGroups ?? [];
  const advertisedRanges = full.bgp?.advertisedIpRanges ?? [];
  // DEFAULT mode advertises all subnets. CUSTOM mode only advertises what's
  // listed — explicit "ALL_SUBNETS" in advertisedGroups means yes too.
  const advertisesAllSubnets =
    advertiseMode === "DEFAULT" || advertisedGroups.includes("ALL_SUBNETS");

  const advertisedRangeRows = advertisedRanges
    .filter((r) => typeof r.range === "string" && r.range.length > 0)
    .map((r) => ({
      cells: { range: String(r.range), description: String(r.description ?? "") },
    }));

  const peers = full.bgpPeers ?? [];
  const sessionsForPolicy = (policyName: string): string => {
    const count = peers.filter(
      (p) =>
        (p.importPolicies ?? []).includes(policyName) ||
        (p.exportPolicies ?? []).includes(policyName),
    ).length;
    return count > 0 ? String(count) : "—";
  };
  const policies = policiesData.result ?? [];
  const policyTypeLabel = (raw: string): string => {
    if (raw === "ROUTE_POLICY_TYPE_IMPORT") return "Import";
    if (raw === "ROUTE_POLICY_TYPE_EXPORT") return "Export";
    return raw || "—";
  };

  const nats = full.nats ?? [];
  const natRows = nats
    .filter((n) => typeof n.name === "string" && n.name.length > 0)
    .map((n) => ({ cells: { name: String(n.name), status: "Active" } }));

  const bgpDetailItems = [
    { key: "BGP ASN", value: full.bgp?.asn ? String(full.bgp.asn) : "—" },
    { key: "Advertise mode", value: advertiseMode },
    { key: "Advertise all available subnets", value: advertisesAllSubnets ? "Yes" : "No" },
  ];

  const advertisementsSection: SectionNode = {
    kind: "section",
    title: "BGP advertisements",
    children: [{ kind: "key-value-list", items: bgpDetailItems }],
  };
  if (advertisedRangeRows.length > 0) {
    advertisementsSection.children.push({
      kind: "table",
      columns: [
        { key: "range", label: "Custom IP range", mono: true, width: "narrow" },
        { key: "description", label: "Description" },
      ],
      rows: advertisedRangeRows,
    });
  } else {
    advertisementsSection.children.push({
      kind: "text",
      content: "This router does not advertise any custom IP ranges.",
    });
  }

  const policiesSection: SectionNode = {
    kind: "section",
    title: "BGP route policies",
    children: [],
  };
  if (policiesData.error) {
    policiesSection.children.push({
      kind: "text",
      content: `Could not load route policies: ${policiesData.error}`,
    });
  } else if (policies.length === 0) {
    policiesSection.children.push({ kind: "text", content: "No BGP route policies." });
  } else {
    policiesSection.children.push({
      kind: "table",
      columns: [
        { key: "name", label: "Name", mono: true },
        { key: "type", label: "Type", width: "narrow" },
        { key: "termCount", label: "Term count", width: "narrow" },
        { key: "bgpSessions", label: "BGP sessions", width: "narrow" },
      ],
      rows: policies.map((p) => ({
        cells: {
          name: String(p.name ?? ""),
          type: policyTypeLabel(String(p.type ?? "")),
          termCount: String((p.terms ?? []).length),
          bgpSessions: sessionsForPolicy(String(p.name ?? "")),
        },
      })),
    });
  }

  const natSection: SectionNode = {
    kind: "section",
    title: "Cloud NAT gateways",
    children: [],
  };
  if (natRows.length === 0) {
    natSection.children.push({ kind: "text", content: "No Cloud NAT gateways." });
  } else {
    natSection.children.push({
      kind: "table",
      columns: [
        { key: "name", label: "Gateway name", mono: true },
        { key: "status", label: "Status", width: "narrow" },
      ],
      rows: natRows,
    });
  }

  base.sections = [...base.sections, advertisementsSection, policiesSection, natSection];

  if (full.error) {
    base.sections.push({
      kind: "section",
      title: "Router details",
      children: [{ kind: "text", content: `Could not load router details: ${full.error}` }],
    });
  }
}

/** Apply the Cloud NAT renderer to `base`. */
export function renderCloudNat(resource: ResourceInstance, base: DetailViewSchema): void {
  base.subtitle = "Cloud NAT";
  base.status = { kind: "status-dot", status: "healthy", label: "Active" };
  base.metricsCapability = { defaultTimeRangeMs: 3_600_000 };

  interface NatLogConfig {
    enable?: boolean;
    filter?: string;
  }
  interface NatConfig {
    name?: string;
    natIpAllocateOption?: string;
    natIps?: string[];
    sourceSubnetworkIpRangesToNat?: string;
    enableDynamicPortAllocation?: boolean;
    minPortsPerVm?: number;
    maxPortsPerVm?: number;
    enableEndpointIndependentMapping?: boolean;
    udpIdleTimeoutSec?: number;
    tcpEstablishedIdleTimeoutSec?: number;
    tcpTransitoryIdleTimeoutSec?: number;
    tcpTimeWaitTimeoutSec?: number;
    icmpIdleTimeoutSec?: number;
    logConfig?: NatLogConfig;
  }
  interface RouterDoc {
    nats?: NatConfig[];
    error?: string;
  }
  interface NatStatus {
    name?: string;
    autoAllocatedNatIps?: string[];
    userAllocatedNatIps?: string[];
    numVmEndpointsWithNatMappings?: number;
    minExtraNatIpsNeeded?: number;
  }
  interface RouterStatusDoc {
    result?: { natStatus?: NatStatus[] };
    error?: string;
  }

  const parseJson = <T>(raw: unknown, fallback: T): T => {
    const s = String(raw ?? "");
    if (!s) return fallback;
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  };

  const router = parseJson<RouterDoc>(resource.resolvedOutputs["cloudNatRouter"], {});
  const status = parseJson<RouterStatusDoc>(resource.resolvedOutputs["cloudNatStatus"], {});
  const natName = String(resource.fields["name"] ?? "");
  const natConfig = (router.nats ?? []).find((n) => n.name === natName) ?? {};
  const natStatus = (status.result?.natStatus ?? []).find((n) => n.name === natName) ?? {};

  const allocationOption = String(
    natConfig.natIpAllocateOption ?? resource.fields["natIpAllocateOption"] ?? "AUTO_ONLY",
  );
  const autoIps = natStatus.autoAllocatedNatIps ?? [];
  const userIps = natStatus.userAllocatedNatIps ?? [];
  const allocatedIps = [...autoIps, ...userIps];
  const ipv4Count = allocatedIps.length;
  const minExtraNeeded = Number(natStatus.minExtraNatIpsNeeded ?? 0);

  const allocatedSection: SectionNode = {
    kind: "section",
    title: "Allocated external IP addresses",
    children: [
      {
        kind: "key-value-list",
        items: [
          { key: "Allocated external IPv4 addresses", value: String(ipv4Count) },
          {
            key: "IP allocation",
            value: allocationOption === "AUTO_ONLY" ? "Automatic" : "Manual",
          },
          {
            key: "VM endpoints with NAT mappings",
            value: String(natStatus.numVmEndpointsWithNatMappings ?? 0),
          },
          ...(minExtraNeeded > 0
            ? [{ key: "Min extra NAT IPs needed", value: String(minExtraNeeded) }]
            : []),
        ],
      },
    ],
  };
  if (allocatedIps.length > 0) {
    allocatedSection.children.push({
      kind: "table",
      columns: [
        { key: "address", label: "External IPv4 address", mono: true },
        { key: "type", label: "Type", width: "narrow" },
      ],
      rows: [
        ...autoIps.map((ip) => ({ cells: { address: ip, type: "Auto" } })),
        ...userIps.map((ip) => ({ cells: { address: ip, type: "Manual" } })),
      ],
    });
  }

  const dynamic = natConfig.enableDynamicPortAllocation === true;
  const eim = natConfig.enableEndpointIndependentMapping === true;
  const minPorts = natConfig.minPortsPerVm ?? 64;
  const maxPorts = natConfig.maxPortsPerVm;

  const portAllocationItems = [
    { key: "Dynamic port allocation", value: dynamic ? "Enabled" : "Disabled" },
    { key: "Minimum ports per VM instance", value: String(minPorts) },
    ...(dynamic && typeof maxPorts === "number"
      ? [{ key: "Maximum ports per VM instance", value: String(maxPorts) }]
      : []),
    { key: "Endpoint-Independent Mapping", value: eim ? "Enabled" : "Disabled" },
  ];

  const timeoutItems = [
    { key: "UDP", value: `${natConfig.udpIdleTimeoutSec ?? 30} seconds` },
    {
      key: "TCP established",
      value: `${natConfig.tcpEstablishedIdleTimeoutSec ?? 1200} seconds`,
    },
    {
      key: "TCP transitory",
      value: `${natConfig.tcpTransitoryIdleTimeoutSec ?? 30} seconds`,
    },
    { key: "ICMP", value: `${natConfig.icmpIdleTimeoutSec ?? 30} seconds` },
    {
      key: "TCP time wait",
      value: `${natConfig.tcpTimeWaitTimeoutSec ?? 120} seconds`,
    },
  ];

  const portAllocationSection: SectionNode = {
    kind: "section",
    title: "Port allocation",
    children: [{ kind: "key-value-list", items: portAllocationItems }],
  };

  const timeoutSection: SectionNode = {
    kind: "section",
    title: "Timeout for protocol connections",
    children: [{ kind: "key-value-list", items: timeoutItems }],
  };

  const logEnable = natConfig.logConfig?.enable === true;
  const logFilter = String(natConfig.logConfig?.filter ?? "");
  const logFilterLabel =
    logFilter === "ALL"
      ? "Translations and errors"
      : logFilter === "TRANSLATIONS_ONLY"
        ? "Translations only"
        : logFilter === "ERRORS_ONLY"
          ? "Errors only"
          : logFilter || "—";
  const loggingSection: SectionNode = {
    kind: "section",
    title: "Logging",
    children: [
      {
        kind: "key-value-list",
        items: [
          { key: "Logging", value: logEnable ? "Enabled" : "No logging" },
          ...(logEnable ? [{ key: "Filter", value: logFilterLabel }] : []),
        ],
      },
    ],
  };

  base.sections = [
    ...base.sections,
    allocatedSection,
    portAllocationSection,
    timeoutSection,
    loggingSection,
  ];

  if (router.error) {
    base.sections.push({
      kind: "section",
      title: "Router config",
      children: [{ kind: "text", content: `Could not load router config: ${router.error}` }],
    });
  }
  if (status.error) {
    base.sections.push({
      kind: "section",
      title: "Router status",
      children: [{ kind: "text", content: `Could not load router status: ${status.error}` }],
    });
  }
}

/** Apply the Backend Service renderer to `base`. */
export function renderBackendService(resource: ResourceInstance, base: DetailViewSchema): void {
  const f = resource.fields;
  const scheme = String(f["loadBalancingScheme"] ?? "");
  const protocol = String(f["protocol"] ?? "");
  const schemeLabel =
    scheme === "EXTERNAL_MANAGED"
      ? "External (managed)"
      : scheme === "INTERNAL_MANAGED"
        ? "Internal (managed)"
        : scheme === "INTERNAL_SELF_MANAGED"
          ? "Internal Self-Managed"
          : scheme === "INTERNAL"
            ? "Internal"
            : scheme === "EXTERNAL"
              ? "External (classic)"
              : scheme || "—";
  base.subtitle = `Backend Service · ${schemeLabel}${protocol ? ` · ${protocol}` : ""}`;
  base.status = { kind: "status-dot", status: "healthy", label: "Active" };
  // Only HTTPS-family LBs are wired into fetchMetricSeries; surface metrics
  // when those metrics are likely to exist.
  const cdnEligible =
    (scheme === "EXTERNAL" || scheme === "EXTERNAL_MANAGED") &&
    (protocol === "HTTP" || protocol === "HTTPS" || protocol === "HTTP2");
  if (cdnEligible) {
    base.metricsCapability = { defaultTimeRangeMs: 3_600_000 };
  }

  const cfgItems = [
    { key: "Protocol", value: protocol || "—" },
    { key: "Load balancing scheme", value: schemeLabel },
    { key: "Port name", value: String(f["portName"] ?? "") || "—" },
    {
      key: "Backend timeout",
      value: f["timeoutSec"] ? `${String(f["timeoutSec"])} seconds` : "—",
    },
    {
      key: "Connection draining",
      value:
        f["connectionDrainingTimeoutSec"] != null
          ? `${String(f["connectionDrainingTimeoutSec"])} seconds`
          : "—",
    },
    { key: "Session affinity", value: String(f["sessionAffinity"] ?? "NONE") },
    { key: "Cloud CDN", value: f["enableCDN"] === true ? "Enabled" : "Disabled" },
    { key: "Backends", value: String(f["backendCount"] ?? 0) },
    { key: "Health checks", value: String(f["healthCheckCount"] ?? 0) },
  ];

  base.sections = [
    ...base.sections,
    {
      kind: "section",
      title: "Configuration",
      children: [{ kind: "key-value-list", items: cfgItems }],
    },
  ];

  if (Number(f["healthCheckCount"] ?? 0) === 0) {
    base.sections.push({
      kind: "section",
      title: "Health checks",
      children: [
        {
          kind: "text",
          content:
            "No health check attached. Required for instance-group and zonal NEG backends — leave empty only for Internet NEG or Serverless NEG.",
        },
      ],
    });
  }
}
