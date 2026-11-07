/**
 * Listers and payload mappers for DigitalOcean's networking and platform
 * services: load balancers, Cloud Firewalls, certificates, CDN endpoints,
 * Uptime checks, VPC NAT gateways, VPC peerings, App Platform apps and
 * Droplet autoscale pools.
 *
 * Every mapper is exported because the update path re-maps the PUT response
 * through the same function, so a list row and an edited row can never
 * disagree about a field. Shapes are verified against digitalocean/openapi
 * (`specification/resources/<product>/models/`).
 */
import type { ApiListItem, ResourceInstance } from "@infrawrench/plugin-base";
import type { operations } from "./api-types.gen.js";
import { failedWith } from "./api.js";
import type { DoListerContext } from "./resource-listers.js";

type DoLoadBalancer = ApiListItem<operations["loadBalancers_list"], "load_balancers">;
type DoFirewall = ApiListItem<operations["firewalls_list"], "firewalls">;
type DoCertificate = ApiListItem<operations["certificates_list"], "certificates">;
type DoCdnEndpoint = ApiListItem<operations["cdn_list_endpoints"], "endpoints">;
type DoUptimeCheck = ApiListItem<operations["uptime_list_checks"], "checks">;
type DoVpcNatGateway = ApiListItem<operations["vpcnatgateways_list"], "vpc_nat_gateways">;
type DoVpcPeering = ApiListItem<operations["vpcPeerings_list"], "vpc_peerings">;
type DoApp = ApiListItem<operations["apps_list"], "apps">;
type DoAppSpec = NonNullable<DoApp["spec"]>;
type DoAutoscalePool = ApiListItem<operations["autoscalepools_list"], "autoscale_pools">;
type DoForwardingRule = NonNullable<DoLoadBalancer["forwarding_rules"]>[number];
type DoFirewallRule = Partial<NonNullable<DoFirewall["inbound_rules"]>[number]> &
  Partial<NonNullable<DoFirewall["outbound_rules"]>[number]> & { action?: string };
/** A pool's `config`: the document's dynamic and static shapes, either of which may arrive. */
interface DoPoolConfig {
  target_number_instances?: number | null;
  min_instances?: number | null;
  max_instances?: number | null;
  target_cpu_utilization?: number | null;
  target_memory_utilization?: number | null;
  cooldown_minutes?: number | null;
}

/** The resource type ids this module owns. */
export const SERVICE_TYPE_IDS = [
  "load-balancer",
  "firewall",
  "certificate",
  "cdn-endpoint",
  "uptime-check",
  "vpc-nat-gateway",
  "vpc-peering",
  "app",
  "autoscale-pool",
] as const;

const serviceTypeIds: readonly string[] = SERVICE_TYPE_IDS;

export function isServiceTypeId(typeId: string): boolean {
  return serviceTypeIds.includes(typeId);
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

/** The list, or nothing where the provider sent something else. */
function arr<T>(value: readonly T[] | null | undefined): T[];
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The object, or an empty one where the provider sent something else. */
function obj<T extends object>(value: T | null | undefined): Partial<T>;
function obj(value: object | null | undefined): object {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Build the host instance shape shared by every mapper below. */
function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, string | number | boolean>,
  resolvedOutputs: Record<string, string>,
  opts: { createdAt?: string; updatedAt?: string; projectId?: string } = {},
): ResourceInstance {
  const now = new Date().toISOString();
  const createdAt = opts.createdAt || now;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: "digitalocean",
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields,
    resolvedOutputs: Object.fromEntries(Object.entries(resolvedOutputs).filter(([, v]) => !!v)),
    secretStates: [],
    externalId,
    ...(opts.projectId ? { parentResourceId: `${accountId}:project:${opts.projectId}` } : {}),
    createdAt,
    updatedAt: opts.updatedAt || createdAt,
  };
}

/** `https:443 → http:80` style summary of one forwarding rule. */
export function describeForwardingRule(rule: Partial<DoForwardingRule>): string {
  const entry = `${str(rule.entry_protocol)}:${str(rule.entry_port)}`;
  const target = `${str(rule.target_protocol)}:${str(rule.target_port)}`;
  const extra = rule.tls_passthrough === true ? " (TLS passthrough)" : "";
  return `${entry} → ${target}${extra}`;
}

export function mapLoadBalancer(lb: Partial<DoLoadBalancer>, accountId: string): ResourceInstance {
  const id = str(lb.id);
  const region = obj(lb.region);
  const rules = arr(lb.forwarding_rules).map((r) => obj(r));
  const createdAt = str(lb.created_at);
  return instance(
    accountId,
    "load-balancer",
    id,
    str(lb.name),
    {
      name: str(lb.name),
      // Global load balancers have no region; the API returns no object.
      region: str(region.slug ?? lb.region),
      lbType: str(lb.type) || "REGIONAL",
      network: str(lb.network) || "EXTERNAL",
      sizeUnit: Number(lb.size_unit ?? 0) || 0,
      redirectHttpToHttps: lb.redirect_http_to_https === true,
      httpIdleTimeoutSeconds: Number(lb.http_idle_timeout_seconds ?? 0) || 0,
      enableProxyProtocol: lb.enable_proxy_protocol === true,
      enableBackendKeepalive: lb.enable_backend_keepalive === true,
      tlsCipherPolicy: str(lb.tls_cipher_policy) || "DEFAULT",
      status: str(lb.status),
      dropletIds: arr(lb.droplet_ids).map(str).filter(Boolean).join(","),
      dropletTag: str(lb.tag),
      forwardingRules: rules.map(describeForwardingRule).join(", "),
      vpcUuid: str(lb.vpc_uuid),
      createdAt,
    },
    {
      ip: str(lb.ip),
      ipv6: str(lb.ipv6),
      loadBalancerId: id,
      // The full rule/health-check payload for the detail page, which edits
      // rules rather than a summary string.
      __rules__: JSON.stringify(rules),
      __healthCheck__: JSON.stringify(obj(lb.health_check)),
      __stickySessions__: JSON.stringify(obj(lb.sticky_sessions)),
    },
    { createdAt, projectId: str(lb.project_id) },
  );
}

/** `tcp 22 from 0.0.0.0/0, ::/0` style summary of one firewall rule. */
export function describeFirewallRule(
  rule: DoFirewallRule,
  direction: "inbound" | "outbound",
): string {
  const target = obj(direction === "inbound" ? rule.sources : rule.destinations);
  const parts = [
    ...arr(target.addresses).map(str),
    ...arr(target.droplet_ids).map((d) => `droplet ${str(d)}`),
    ...arr(target.load_balancer_uids).map((d) => `load balancer ${str(d)}`),
    ...arr(target.kubernetes_ids).map((d) => `cluster ${str(d)}`),
    ...arr(target.tags).map((t) => `tag:${str(t)}`),
  ];
  const ports = str(rule.ports);
  const portText = !ports || ports === "0" ? "all ports" : ports;
  const action = str(rule.action) || "allow";
  return `${action} ${str(rule.protocol)} ${portText} ${direction === "inbound" ? "from" : "to"} ${parts.join(", ") || "nowhere"}`;
}

export function mapFirewall(fw: Partial<DoFirewall>, accountId: string): ResourceInstance {
  const id = str(fw.id);
  const inbound = arr(fw.inbound_rules).map((r) => obj(r));
  const outbound = arr(fw.outbound_rules).map((r) => obj(r));
  const createdAt = str(fw.created_at);
  return instance(
    accountId,
    "firewall",
    id,
    str(fw.name),
    {
      name: str(fw.name),
      status: str(fw.status),
      dropletIds: arr(fw.droplet_ids).map(str).filter(Boolean).join(","),
      tags: arr(fw.tags).map(str).filter(Boolean).join(","),
      inboundRuleCount: inbound.length,
      outboundRuleCount: outbound.length,
      createdAt,
    },
    {
      __inbound__: JSON.stringify(inbound),
      __outbound__: JSON.stringify(outbound),
      __pending__: JSON.stringify(arr(fw.pending_changes)),
    },
    { createdAt },
  );
}

export function mapCertificate(c: Partial<DoCertificate>, accountId: string): ResourceInstance {
  const id = str(c.id);
  const createdAt = str(c.created_at);
  return instance(
    accountId,
    "certificate",
    id,
    str(c.name),
    {
      name: str(c.name),
      type: str(c.type),
      state: str(c.state),
      dnsNames: arr(c.dns_names).map(str).filter(Boolean).join(","),
      notAfter: str(c.not_after),
      sha1Fingerprint: str(c.sha1_fingerprint),
      createdAt,
    },
    { certificateId: id },
    { createdAt },
  );
}

export function mapCdnEndpoint(e: Partial<DoCdnEndpoint>, accountId: string): ResourceInstance {
  const id = str(e.id);
  const createdAt = str(e.created_at);
  const endpoint = str(e.endpoint);
  const customDomain = str(e.custom_domain);
  return instance(
    accountId,
    "cdn-endpoint",
    id,
    customDomain || endpoint || str(e.origin),
    {
      origin: str(e.origin),
      endpoint,
      ttl: str(e.ttl ?? 3600),
      customDomain,
      certificateId: str(e.certificate_id),
      createdAt,
    },
    { endpoint, url: endpoint ? `https://${customDomain || endpoint}` : "" },
    { createdAt },
  );
}

export function mapUptimeCheck(c: Partial<DoUptimeCheck>, accountId: string): ResourceInstance {
  const id = str(c.id);
  return instance(
    accountId,
    "uptime-check",
    id,
    str(c.name),
    {
      name: str(c.name),
      type: str(c.type),
      target: str(c.target),
      regions: arr(c.regions).map(str).filter(Boolean).join(","),
      enabled: c.enabled !== false,
    },
    {},
  );
}

export function mapVpcNatGateway(g: Partial<DoVpcNatGateway>, accountId: string): ResourceInstance {
  const id = str(g.id);
  const vpcs = arr(g.vpcs).map((v) => obj(v));
  const egress = arr(obj(g.egresses).public_gateways).map((p) => obj(p));
  const createdAt = str(g.created_at);
  return instance(
    accountId,
    "vpc-nat-gateway",
    id,
    str(g.name),
    {
      name: str(g.name),
      region: str(g.region),
      state: str(g.state),
      size: Number(g.size ?? 0) || 0,
      vpcUuids: vpcs
        .map((v) => str(v.vpc_uuid))
        .filter(Boolean)
        .join(","),
      egressIp: egress
        .map((p) => str(p.ipv4))
        .filter(Boolean)
        .join(","),
      udpTimeoutSeconds: Number(g.udp_timeout_seconds ?? 0) || 0,
      tcpTimeoutSeconds: Number(g.tcp_timeout_seconds ?? 0) || 0,
      icmpTimeoutSeconds: Number(g.icmp_timeout_seconds ?? 0) || 0,
      createdAt,
    },
    {
      egressIp: egress.map((p) => str(p.ipv4)).filter(Boolean)[0] ?? "",
      __vpcs__: JSON.stringify(vpcs),
    },
    { createdAt, updatedAt: str(g.updated_at) },
  );
}

export function mapVpcPeering(p: Partial<DoVpcPeering>, accountId: string): ResourceInstance {
  const id = str(p.id);
  const createdAt = str(p.created_at);
  return instance(
    accountId,
    "vpc-peering",
    id,
    str(p.name),
    {
      name: str(p.name),
      status: str(p.status),
      vpcIds: arr(p.vpc_ids).map(str).filter(Boolean).join(","),
      createdAt,
    },
    {},
    { createdAt },
  );
}

/** Every component name in an app spec, across all component kinds. */
export function appComponentNames(spec: Partial<DoAppSpec>): string[] {
  const kinds = ["services", "workers", "jobs", "static_sites", "functions"] as const;
  return kinds.flatMap((k) =>
    arr<{ name?: string }>(spec[k])
      .map((c) => str(obj(c).name))
      .filter(Boolean),
  );
}

export function mapApp(a: Partial<DoApp>, accountId: string): ResourceInstance {
  const id = str(a.id);
  const spec = obj(a.spec);
  const active = obj(a.active_deployment);
  const inProgress = obj(a.in_progress_deployment);
  const createdAt = str(a.created_at);
  const liveUrl = str(a.live_url);
  return instance(
    accountId,
    "app",
    id,
    str(spec.name),
    {
      name: str(spec.name),
      region: str(obj(a.region).slug ?? spec.region),
      // An in-flight deployment is the more useful phase to show: it is what
      // the user is waiting on.
      phase: str(inProgress.phase ?? active.phase),
      liveUrl,
      components: appComponentNames(spec).join(","),
      activeDeploymentId: str(active.id),
      lastDeployedAt: str(a.last_deployment_created_at),
      tierSlug: str(a.tier_slug),
      createdAt,
    },
    {
      liveUrl,
      defaultIngress: str(a.default_ingress),
      __inProgressDeploymentId__: str(inProgress.id),
    },
    { createdAt, updatedAt: str(a.updated_at), projectId: str(a.project_id) },
  );
}

/** DO stores utilisation targets as 0.05-1 fractions; fields show percent. */
function fractionToPercent(value: number | null | undefined): number | "" {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : "";
}

export function mapAutoscalePool(p: Partial<DoAutoscalePool>, accountId: string): ResourceInstance {
  const id = str(p.id);
  const config: DoPoolConfig = obj(p.config);
  const template = obj(p.droplet_template);
  const isStatic = config.target_number_instances != null;
  const createdAt = str(p.created_at);
  return instance(
    accountId,
    "autoscale-pool",
    id,
    str(p.name),
    {
      name: str(p.name),
      status: str(p.status),
      region: str(template.region),
      size: str(template.size),
      image: str(template.image),
      mode: isStatic ? "static" : "dynamic",
      targetNumberInstances: isStatic ? Number(config.target_number_instances) : "",
      minInstances: isStatic ? "" : Number(config.min_instances ?? 0),
      maxInstances: isStatic ? "" : Number(config.max_instances ?? 0),
      targetCpuUtilization: fractionToPercent(config.target_cpu_utilization),
      targetMemoryUtilization: fractionToPercent(config.target_memory_utilization),
      cooldownMinutes: isStatic ? "" : Number(config.cooldown_minutes ?? 0) || "",
      activeResourcesCount: Number(p.active_resources_count ?? 0),
      vpcUuid: str(template.vpc_uuid),
      createdAt,
    },
    {
      // The PUT needs the full template echoed back; keep it verbatim.
      __template__: JSON.stringify(template),
      __utilization__: JSON.stringify(obj(p.current_utilization)),
    },
    { createdAt, updatedAt: str(p.updated_at) },
  );
}

/**
 * Waits for a request, except that a 403/404 collapses to none: NAT gateways, peerings
 * and autoscale pools are newer products and an older token, or an account without
 * access, should get an empty sidebar group, not an error.
 */
async function orEmptyWhenAbsent<T>(request: Promise<T[]>): Promise<T[]> {
  try {
    return await request;
  } catch (err) {
    if (failedWith(err, 403, 404)) return [];
    throw err;
  }
}

/** List one of this module's types, or `null` when `typeId` is not ours. */
export async function listDoServiceResources(
  ctx: DoListerContext,
  typeId: string,
  accountId: string,
): Promise<ResourceInstance[] | null> {
  switch (typeId) {
    case "load-balancer": {
      const rows = await ctx.api.getAll("/load_balancers", "load_balancers");
      return rows.map((lb) => mapLoadBalancer(lb, accountId));
    }
    case "firewall": {
      const rows = await ctx.api.getAll("/firewalls", "firewalls");
      return rows.map((fw) => mapFirewall(fw, accountId));
    }
    case "certificate": {
      const rows = await ctx.api.getAll("/certificates", "certificates");
      return rows.map((c) => mapCertificate(c, accountId));
    }
    case "cdn-endpoint": {
      const rows = await ctx.api.getAll("/cdn/endpoints", "endpoints");
      return rows.map((e) => mapCdnEndpoint(e, accountId));
    }
    case "uptime-check": {
      const rows = await orEmptyWhenAbsent(ctx.api.getAll("/uptime/checks", "checks"));
      return rows.map((c) => mapUptimeCheck(c, accountId));
    }
    case "vpc-nat-gateway": {
      const rows = await orEmptyWhenAbsent(ctx.api.getAll("/vpc_nat_gateways", "vpc_nat_gateways"));
      return rows.map((g) => mapVpcNatGateway(g, accountId));
    }
    case "vpc-peering": {
      const rows = await orEmptyWhenAbsent(ctx.api.getAll("/vpc_peerings", "vpc_peerings"));
      return rows.map((p) => mapVpcPeering(p, accountId));
    }
    case "app": {
      // `with_projects=true` makes DO include `project_id`, which nests the
      // app under its project without a URN lookup.
      const rows = await ctx.api.getAll("/apps", "apps", { query: { with_projects: true } });
      return rows.map((a) => mapApp(a, accountId));
    }
    case "autoscale-pool": {
      const rows = await orEmptyWhenAbsent(
        ctx.api.getAll("/droplets/autoscale", "autoscale_pools"),
      );
      return rows.map((p) => mapAutoscalePool(p, accountId));
    }
    default:
      return null;
  }
}
