import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { GCP_REGIONS } from "./regions.js";
import type { GcpCreateContext } from "./create-context.js";

export const networkingCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "vpc-network": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "name",
          label: "Network Name",
          kind: "text",
          required: true,
          description: "Name for the VPC network (letters, numbers, hyphens)",
        },
        {
          key: "autoCreateSubnetworks",
          label: "Auto-create Subnets",
          kind: "select",
          required: true,
          options: [
            { id: "true", label: "Auto mode (one subnet per region)" },
            { id: "false", label: "Custom mode (no subnets created)" },
          ],
          defaultValue: "true",
        },
      ],
    };
  },
  subnet: async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "name",
          label: "Subnet Name",
          kind: "text",
          required: true,
        },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: GCP_REGIONS,
          defaultValue: "us-central1",
        },
        {
          key: "network",
          label: "Network",
          kind: "text",
          required: true,
          description: "VPC network name (e.g. default)",
        },
        {
          key: "ipCidrRange",
          label: "IP CIDR Range",
          kind: "text",
          required: true,
          description: "e.g. 10.0.0.0/24",
        },
      ],
    };
  },
  "firewall-rule": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "name",
          label: "Rule Name",
          kind: "text",
          required: true,
        },
        {
          key: "network",
          label: "VPC Network",
          kind: "resource-picker",
          required: true,
          description: "VPC network this rule applies to",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "vpc-network", outputKey: "selfLink" },
          ],
        },
        {
          key: "direction",
          label: "Direction",
          kind: "select",
          required: true,
          options: [
            { id: "INGRESS", label: "Ingress" },
            { id: "EGRESS", label: "Egress" },
          ],
          defaultValue: "INGRESS",
        },
        {
          key: "protocol",
          label: "Protocol",
          kind: "select",
          required: true,
          options: [
            { id: "tcp", label: "TCP" },
            { id: "udp", label: "UDP" },
            { id: "icmp", label: "ICMP" },
            { id: "all", label: "All" },
          ],
          defaultValue: "tcp",
        },
        {
          key: "ports",
          label: "Ports",
          kind: "text",
          required: false,
          description: "Comma-separated ports or ranges (e.g. 80,443,8000-9000)",
        },
        {
          key: "sourceRanges",
          label: "Source Ranges",
          kind: "text",
          required: false,
          description: "Comma-separated CIDRs (e.g. 0.0.0.0/0)",
        },
      ],
    };
  },
  "cloud-router": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "name",
          label: "Router Name",
          kind: "text",
          required: true,
        },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: GCP_REGIONS,
          defaultValue: "us-central1",
        },
        {
          key: "network",
          label: "VPC Network",
          kind: "resource-picker",
          required: true,
          description: "VPC network the router attaches to",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "vpc-network", outputKey: "selfLink" },
          ],
        },
      ],
    };
  },
  "cloud-nat": async (ctx, parentResourceId) => {
    return {
      fields: [
        { key: "name", label: "NAT Name", kind: "text", required: true },
        {
          key: "router",
          label: "Cloud Router",
          kind: "resource-picker",
          required: true,
          description: "Router this NAT gateway will run on",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "cloud-router", outputKey: "selfLink" },
          ],
        },
        {
          key: "natIpAllocateOption",
          label: "IP Allocation",
          kind: "select",
          required: false,
          options: [
            { id: "AUTO_ONLY", label: "Automatic" },
            { id: "MANUAL_ONLY", label: "Manual" },
          ],
          defaultValue: "AUTO_ONLY",
        },
        {
          key: "sourceSubnetworkIpRangesToNat",
          label: "Subnet IP Ranges",
          kind: "select",
          required: false,
          options: [
            { id: "ALL_SUBNETWORKS_ALL_IP_RANGES", label: "All subnets, all IP ranges" },
            {
              id: "ALL_SUBNETWORKS_ALL_PRIMARY_IP_RANGES",
              label: "All subnets, primary IP ranges only",
            },
            { id: "LIST_OF_SUBNETWORKS", label: "Custom subnet list" },
          ],
          defaultValue: "ALL_SUBNETWORKS_ALL_IP_RANGES",
        },
      ],
    };
  },
  "ssl-certificate": async (ctx, parentResourceId) => {
    return {
      fields: [
        { key: "name", label: "Certificate Name", kind: "text", required: true },
        {
          key: "domains",
          label: "Domains",
          kind: "text",
          required: true,
          description: "Comma-separated list of domains (Google-managed certificate)",
        },
      ],
    };
  },
  "backend-service": async (ctx, parentResourceId) => {
    return {
      fields: [
        { key: "name", label: "Service Name", kind: "text", required: true },
        {
          key: "description",
          label: "Description",
          kind: "text",
          required: false,
          description: "Optional human-readable description.",
        },
        {
          key: "loadBalancingScheme",
          label: "Load Balancing Scheme",
          kind: "select",
          required: true,
          options: [
            { id: "EXTERNAL_MANAGED", label: "External Managed (Global Application LB)" },
            { id: "EXTERNAL", label: "External (Classic / Network LB)" },
            { id: "INTERNAL_SELF_MANAGED", label: "Internal Self-Managed (Traffic Director)" },
          ],
          defaultValue: "EXTERNAL_MANAGED",
          description:
            "Choose External Managed for the modern global Application Load Balancer. Use Classic External for legacy HTTP(S) or proxy/network LBs.",
        },
        {
          key: "protocol",
          label: "Protocol",
          kind: "select",
          required: true,
          options: [
            { id: "HTTP", label: "HTTP" },
            { id: "HTTPS", label: "HTTPS" },
            { id: "HTTP2", label: "HTTP/2" },
            { id: "TCP", label: "TCP" },
            { id: "SSL", label: "SSL" },
            { id: "GRPC", label: "gRPC" },
          ],
          defaultValue: "HTTP",
        },
        {
          key: "portName",
          label: "Port Name",
          kind: "text",
          required: false,
          description:
            "Named port on backend instance groups (e.g. 'http'). Required when using instance-group backends with EXTERNAL/INTERNAL_MANAGED/INTERNAL_SELF_MANAGED.",
        },
        {
          key: "timeoutSec",
          label: "Backend Timeout (s)",
          kind: "number",
          required: false,
          defaultValue: "30",
          minValue: 1,
          maxValue: 2_147_483_647,
          description: "How long the load balancer waits for a backend response.",
        },
        {
          key: "connectionDrainingTimeoutSec",
          label: "Connection Draining (s)",
          kind: "number",
          required: false,
          defaultValue: "0",
          minValue: 0,
          maxValue: 3600,
          description:
            "How long to keep existing connections open after a backend is removed from the pool.",
        },
        {
          key: "sessionAffinity",
          label: "Session Affinity",
          kind: "select",
          required: false,
          options: [
            { id: "NONE", label: "None" },
            { id: "CLIENT_IP", label: "Client IP" },
            { id: "CLIENT_IP_PORT_PROTO", label: "Client IP, port, protocol" },
            { id: "CLIENT_IP_PROTO", label: "Client IP, protocol" },
            { id: "GENERATED_COOKIE", label: "Generated cookie (HTTP/S only)" },
            { id: "HEADER_FIELD", label: "Header field (HTTP/S only)" },
            { id: "HTTP_COOKIE", label: "HTTP cookie (HTTP/S only)" },
          ],
          defaultValue: "NONE",
        },
        {
          key: "enableCDN",
          label: "Enable Cloud CDN",
          kind: "select",
          required: false,
          options: [
            { id: "false", label: "Disabled" },
            { id: "true", label: "Enabled (HTTP/S external only)" },
          ],
          defaultValue: "false",
          description: "Only valid for EXTERNAL_MANAGED / EXTERNAL with HTTP, HTTPS, or HTTP/2.",
        },
        {
          key: "healthCheck",
          label: "Health Check",
          kind: "resource-picker",
          required: false,
          description:
            "Required for instance-group / zonal NEG backends. Leave empty for Internet NEG or Serverless NEG backends.",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "health-check", outputKey: "selfLink" },
          ],
        },
      ],
    };
  },
  "forwarding-rule": async (ctx, parentResourceId) => {
    const p = ctx.project;
    // Fetch target HTTP proxies and target TCP proxies
    const [httpProxiesData, tcpProxiesData] = await Promise.all([
      ctx
        .get<{
          items?: Array<{ name: string; selfLink: string }>;
        }>(
          `https://compute.googleapis.com/compute/v1/projects/${ctx.project}/global/targetHttpProxies`,
        )
        .catch(() => ({ items: [] as Array<{ name: string; selfLink: string }> })),
      ctx
        .get<{
          items?: Array<{ name: string; selfLink: string }>;
        }>(
          `https://compute.googleapis.com/compute/v1/projects/${ctx.project}/global/targetTcpProxies`,
        )
        .catch(() => ({ items: [] as Array<{ name: string; selfLink: string }> })),
    ]);
    const targetOptions = [
      ...(httpProxiesData.items ?? []).map((p) => ({
        id: p.selfLink ?? p.name,
        label: `${p.name} (HTTP)`,
      })),
      ...(tcpProxiesData.items ?? []).map((p) => ({
        id: p.selfLink ?? p.name,
        label: `${p.name} (TCP)`,
      })),
    ];
    return {
      fields: [
        { key: "name", label: "Rule Name", kind: "text", required: true },
        {
          key: "target",
          label: "Target Proxy",
          kind: targetOptions.length > 0 ? "select" : "text",
          required: true,
          ...(targetOptions.length > 0 ? { options: targetOptions } : {}),
          description: "Target proxy resource URL",
        },
        {
          key: "IPProtocol",
          label: "Protocol",
          kind: "select",
          required: true,
          options: [
            { id: "TCP", label: "TCP" },
            { id: "UDP", label: "UDP" },
            { id: "ESP", label: "ESP" },
            { id: "ICMP", label: "ICMP" },
          ],
          defaultValue: "TCP",
        },
        {
          key: "portRange",
          label: "Port Range",
          kind: "text",
          required: false,
          description: "Port range (e.g. 80-80 or 443-443)",
          defaultValue: "80-80",
        },
      ],
    };
  },
  "health-check": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "name",
          label: "Health Check Name",
          kind: "text",
          required: true,
        },
        {
          key: "type",
          label: "Type",
          kind: "select",
          required: true,
          options: [
            { id: "HTTP", label: "HTTP" },
            { id: "HTTPS", label: "HTTPS" },
            { id: "TCP", label: "TCP" },
          ],
          defaultValue: "HTTP",
        },
        {
          key: "port",
          label: "Port",
          kind: "number",
          required: true,
          defaultValue: "80",
          minValue: 1,
          maxValue: 65535,
        },
        {
          key: "checkIntervalSec",
          label: "Check Interval (s)",
          kind: "number",
          required: false,
          defaultValue: "5",
          minValue: 1,
          maxValue: 300,
        },
      ],
    };
  },
};

export const networkingCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "vpc-network": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const autoCreateSubnetworks = fields["autoCreateSubnetworks"] ?? "true";

    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/networks`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name, autoCreateSubnetworks: autoCreateSubnetworks === "true" }),
      },
    );
    if (!res.ok) throw new Error(`VPC Network API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "vpc-network", `${p}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "vpc-network",
      accountId,
      displayName: name,
      fields: {
        name,
        description: "",
        autoCreateSubnetworks: autoCreateSubnetworks === "true",
        mtu: 1460,
        subnetCount: 0,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${p}/${name}`,
      createdAt: now,
      updatedAt: now,
    };
  },
  subnet: async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const region = fields["region"] ?? "";
    const network = fields["network"] ?? "";
    const ipCidrRange = fields["ipCidrRange"] ?? "";

    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/subnetworks`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          network: `projects/${p}/global/networks/${network}`,
          ipCidrRange,
        }),
      },
    );
    if (!res.ok) throw new Error(`Subnet API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "subnet", `${region}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "subnet",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        network,
        ipCidrRange,
        gatewayAddress: "",
        privateIpGoogleAccess: false,
        purpose: "PRIVATE",
        stackType: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${region}/${name}`,
      createdAt: now,
      updatedAt: now,
    };
  },
  "firewall-rule": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const networkRaw = fields["network"] ?? "";
    const direction = fields["direction"] ?? "INGRESS";
    const protocol = fields["protocol"] ?? "tcp";
    const ports = fields["ports"] ?? "";
    const sourceRanges = fields["sourceRanges"] ?? "";

    // Resource picker hands us a selfLink URL; fall back to wrapping a bare name.
    const networkRef = networkRaw.includes("/")
      ? networkRaw
      : `projects/${p}/global/networks/${networkRaw}`;
    const networkShort = networkRaw.split("/").pop() ?? networkRaw;

    const allowed: Array<Record<string, unknown>> = [
      {
        IPProtocol: protocol,
        ...(ports && protocol !== "icmp" ? { ports: ports.split(",").map((s) => s.trim()) } : {}),
      },
    ];
    const body: Record<string, unknown> = {
      name,
      network: networkRef,
      direction,
      allowed,
    };
    if (sourceRanges) {
      body.sourceRanges = sourceRanges.split(",").map((s) => s.trim());
    }

    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/firewalls`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`Firewall API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const allowedStr = ports ? `${protocol}:${ports}` : protocol;
    return {
      id: ctx.id(accountId, "firewall-rule", name),
      pluginId: "gcp",
      resourceTypeId: "firewall-rule",
      accountId,
      displayName: name,
      fields: {
        name,
        network: networkShort,
        direction,
        priority: 1000,
        action: "ALLOW",
        sourceRanges: sourceRanges,
        destinationRanges: "",
        allowed: allowedStr,
        denied: "",
        disabled: false,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  },
  "cloud-router": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const region = fields["region"] ?? "";
    const networkRaw = fields["network"] ?? "";

    const networkRef = networkRaw.includes("/")
      ? networkRaw
      : `projects/${p}/global/networks/${networkRaw}`;
    const networkShort = networkRaw.split("/").pop() ?? networkRaw;

    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          network: networkRef,
        }),
      },
    );
    if (!res.ok) throw new Error(`Cloud Router API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "cloud-router", `${region}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "cloud-router",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        network: networkShort,
        bgpAsn: 0,
        natCount: 0,
      },
      resolvedOutputs: {
        selfLink: `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${name}`,
      },
      secretStates: [],
      externalId: `${region}/${name}`,
      createdAt: now,
      updatedAt: now,
    };
  },
  "cloud-nat": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const routerField = fields["router"] ?? "";
    // Resource picker hands us a selfLink URL like
    // ".../projects/P/regions/REGION/routers/ROUTER"; the legacy select used
    // a "region/router" pair. Support both shapes.
    const selfLinkMatch = /\/regions\/([^/]+)\/routers\/([^/]+)$/.exec(routerField);
    const [region, routerName] = selfLinkMatch
      ? [selfLinkMatch[1] ?? "", selfLinkMatch[2] ?? ""]
      : routerField.includes("/")
        ? routerField.split("/")
        : ["us-central1", routerField];
    const natIpAllocateOption = fields["natIpAllocateOption"] ?? "AUTO_ONLY";
    const sourceSubnetworkIpRangesToNat =
      fields["sourceSubnetworkIpRangesToNat"] ?? "ALL_SUBNETWORKS_ALL_IP_RANGES";
    const tok = await ctx.token();
    // Get the existing router, patch with new NAT
    const router = await ctx.get<Record<string, unknown>>(
      `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${routerName}`,
    );
    const nats = (router["nats"] as Array<Record<string, unknown>>) ?? [];
    nats.push({
      name,
      natIpAllocateOption,
      sourceSubnetworkIpRangesToNat,
    });
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${routerName}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ nats }),
      },
    );
    if (!res.ok) throw new Error(`Cloud NAT create failed: ${res.status}: ${await res.text()}`);
    const now = new Date().toISOString();
    return {
      id: ctx.id(accountId, "cloud-nat", `${p}/${region}/${routerName}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "cloud-nat",
      accountId,
      displayName: name,
      fields: {
        name,
        region: region ?? "",
        router: routerName ?? "",
        natIpAllocateOption,
        sourceSubnetworkIpRangesToNat,
        status: "ACTIVE",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${p}/${region}/${routerName}/${name}`,
      createdAt: now,
      updatedAt: now,
    };
  },
  "ssl-certificate": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const domainsStr = fields["domains"] ?? "";
    const domains = domainsStr
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    const tok = await ctx.token();
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/sslCertificates`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          type: "MANAGED",
          managed: { domains },
        }),
      },
    );
    if (!res.ok)
      throw new Error(`SSL Certificate create failed: ${res.status}: ${await res.text()}`);
    const now = new Date().toISOString();
    const domainList = domains.join(", ");
    const dnsRecords = domains
      .map((domain) => {
        const recordName = `_acme-challenge.${domain}.`;
        const recordValue = `${name}.${p}.dscvr.cloud.goog.`;
        return `CNAME ${recordName} -> ${recordValue}`;
      })
      .join("\n");
    return {
      id: ctx.id(accountId, "ssl-certificate", name),
      pluginId: "gcp",
      resourceTypeId: "ssl-certificate",
      accountId,
      displayName: name,
      fields: {
        name,
        type: "MANAGED",
        status: "PROVISIONING",
        domains: domainList,
        expireTime: "",
      },
      resolvedOutputs: { dnsRecords, domains: domainList },
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  },
  "backend-service": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const description = fields["description"] ?? "";
    const protocol = fields["protocol"] ?? "HTTP";
    const loadBalancingScheme = fields["loadBalancingScheme"] ?? "EXTERNAL_MANAGED";
    const healthCheckRaw = (fields["healthCheck"] ?? "").trim();
    const portName = (fields["portName"] ?? "").trim();
    const timeoutSec = Number(fields["timeoutSec"] || 30);
    const drainSec = Number(fields["connectionDrainingTimeoutSec"] || 0);
    const sessionAffinity = fields["sessionAffinity"] ?? "NONE";
    const enableCDN = fields["enableCDN"] === "true";

    // Resource picker hands us a selfLink URL. Bare names are wrapped to the
    // global health check path so the API accepts them.
    const healthCheckRef = healthCheckRaw
      ? healthCheckRaw.includes("/")
        ? healthCheckRaw
        : `projects/${p}/global/healthChecks/${healthCheckRaw}`
      : "";

    const body: Record<string, unknown> = {
      name,
      protocol,
      loadBalancingScheme,
      timeoutSec,
      sessionAffinity,
      connectionDraining: { drainingTimeoutSec: drainSec },
    };
    if (description) body["description"] = description;
    if (portName) body["portName"] = portName;
    if (healthCheckRef) body["healthChecks"] = [healthCheckRef];
    // enableCDN is only valid for EXTERNAL/EXTERNAL_MANAGED with HTTP-family protocols.
    if (
      enableCDN &&
      (loadBalancingScheme === "EXTERNAL" || loadBalancingScheme === "EXTERNAL_MANAGED") &&
      (protocol === "HTTP" || protocol === "HTTPS" || protocol === "HTTP2")
    ) {
      body["enableCDN"] = true;
    }

    const tok = await ctx.token();
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/backendServices`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok)
      throw new Error(`Backend Service create failed: ${res.status}: ${await res.text()}`);
    const now = new Date().toISOString();
    const selfLink = `https://www.googleapis.com/compute/v1/projects/${p}/global/backendServices/${name}`;
    return {
      id: ctx.id(accountId, "backend-service", name),
      pluginId: "gcp",
      resourceTypeId: "backend-service",
      accountId,
      displayName: name,
      fields: {
        name,
        description,
        protocol,
        port: 0,
        portName,
        loadBalancingScheme,
        timeoutSec,
        connectionDrainingTimeoutSec: drainSec,
        healthCheckCount: healthCheckRef ? 1 : 0,
        backendCount: 0,
        enableCDN: body["enableCDN"] === true,
        sessionAffinity,
      },
      resolvedOutputs: { selfLink },
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  },
  "forwarding-rule": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const target = fields["target"] ?? "";
    const ipProtocol = fields["IPProtocol"] ?? "TCP";
    const portRange = fields["portRange"] ?? "";
    const tok = await ctx.token();
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/forwardingRules`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          target,
          IPProtocol: ipProtocol,
          portRange,
        }),
      },
    );
    if (!res.ok)
      throw new Error(`Forwarding Rule create failed: ${res.status}: ${await res.text()}`);
    const now = new Date().toISOString();
    return {
      id: ctx.id(accountId, "forwarding-rule", `global/${name}`),
      pluginId: "gcp",
      resourceTypeId: "forwarding-rule",
      accountId,
      displayName: name,
      fields: {
        name,
        region: "global",
        IPAddress: "",
        IPProtocol: ipProtocol,
        portRange,
        target: target.split("/").pop() ?? target,
        loadBalancingScheme: "EXTERNAL",
        networkTier: "PREMIUM",
      },
      resolvedOutputs: { IPAddress: "" },
      secretStates: [],
      externalId: `global/${name}`,
      createdAt: now,
      updatedAt: now,
    };
  },
  "health-check": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const type = fields["type"] ?? "HTTP";
    const port = Number(fields["port"] || 80);
    const checkIntervalSec = Number(fields["checkIntervalSec"] || 5);

    const body: Record<string, unknown> = {
      name,
      type,
      checkIntervalSec,
      timeoutSec: 5,
      healthyThreshold: 2,
      unhealthyThreshold: 2,
    };
    if (type === "HTTP") {
      body.httpHealthCheck = { port };
    } else if (type === "HTTPS") {
      body.httpsHealthCheck = { port };
    } else {
      body.tcpHealthCheck = { port };
    }

    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/healthChecks`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`Health Check API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "health-check", name),
      pluginId: "gcp",
      resourceTypeId: "health-check",
      accountId,
      displayName: name,
      fields: {
        name,
        type,
        port,
        checkIntervalSec,
        timeoutSec: 5,
        healthyThreshold: 2,
        unhealthyThreshold: 2,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  },
};
