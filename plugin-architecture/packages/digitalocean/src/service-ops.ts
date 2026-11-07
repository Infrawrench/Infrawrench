/**
 * Everything past listing and creation for DigitalOcean's networking and
 * platform services (see `./service-listers.ts` for the type list): edit,
 * delete, header actions, prompt commands, detail enrichment, App Platform
 * logs and spec editing, and the load balancer / app / autoscale pool
 * metrics.
 *
 * DO's PUT endpoints for load balancers, firewalls, NAT gateways and
 * autoscale pools all want a *full* representation ("any attribute that is
 * not provided will be reset to its default value"), so every edit re-reads
 * the object and echoes it back with only the changed keys swapped.
 */
import {
  type ApiBody,
  type ApiListItem,
  type MetricSeries,
  type NoSlashString,
  type ResourceInstance,
} from "@infrawrench/plugin-base";
import { idSegment } from "./api.js";
import type { DoApi, DoResponse } from "./api.js";
import type { operations, paths } from "./api-types.gen.js";
import {
  mapAutoscalePool,
  mapCdnEndpoint,
  mapFirewall,
  mapLoadBalancer,
  mapUptimeCheck,
  mapVpcNatGateway,
  mapVpcPeering,
} from "./service-listers.js";
import { parseIdList, UPTIME_REGIONS } from "./create-handlers/services.js";

type Json = Record<string, unknown>;
type DoDropletRow = ApiListItem<operations["droplets_list"], "droplets">;
type DoForwardingRule = NonNullable<
  ApiBody<operations["loadBalancers_add_forwardingRules"]>["forwarding_rules"]
>[number];
type DoFirewallRules = ApiBody<operations["firewalls_add_rules"]>;
type DoInboundRule = NonNullable<DoFirewallRules["inbound_rules"]>[number];
type DoOutboundRule = NonNullable<DoFirewallRules["outbound_rules"]>[number];
/** A pool's `config`: the document's dynamic and static shapes, either of which may arrive. */
interface DoPoolConfig {
  target_number_instances?: number | null;
  min_instances?: number | null;
  max_instances?: number | null;
  target_cpu_utilization?: number | null;
  target_memory_utilization?: number | null;
  cooldown_minutes?: number | null;
}
/** The metric names a `/monitoring/metrics/<family>/` path exists for. */
type MetricName<Family extends string> = {
  [K in keyof paths]: K extends `/monitoring/metrics/${Family}/${infer Name}` ? Name : never;
}[keyof paths];
/** What every `/v2/monitoring/metrics/*` family answers with. */
type PromResponse = DoResponse<"monitoring_get_lb_frontend_cpu_utilization">;

export interface DoServiceContext {
  api: DoApi;
}

/** The object, or an empty one where the provider sent something else. */
function obj<T extends object>(value: T | null | undefined): Partial<T>;
function obj(value: object | null | undefined): object {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** The list, or nothing where the provider sent something else. */
function arr<T>(value: readonly T[] | null | undefined): T[];
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function externalIdOf(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

/** Prompt values arrive JSON-encoded in `args[0]`. */
export function parsePromptArgs(args: (string | number)[]): Record<string, string> {
  const first = args[0];
  if (typeof first !== "string" || !first) return {};
  try {
    const parsed: unknown = JSON.parse(first);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).map(([k, v]) => [k, v == null ? "" : String(v)]),
    );
  } catch {
    return {};
  }
}

function numberIn(raw: string | undefined, min: number, max: number, label: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return n;
}

// ── Load balancers ──────────────────────────────────────────────────────

/**
 * Turn a GET payload into a PUT body: drop the read-only keys, flatten the
 * region object to its slug, and keep exactly one of `droplet_ids` / `tag`
 * (the schema makes them mutually exclusive).
 */
export function loadBalancerPutBody(lb: {
  region?: { slug?: string } | null;
  tag?: string | null;
  [key: string]: unknown;
}): Json {
  const readOnly = ["id", "ip", "ipv6", "status", "created_at", "algorithm", "size"];
  const body: Json = {};
  for (const [k, v] of Object.entries(lb)) {
    if (!readOnly.includes(k) && v !== null && v !== undefined) body[k] = v;
  }
  const region = obj(lb.region);
  if (region.slug) body["region"] = region.slug;
  if (lb.tag) delete body["droplet_ids"];
  else delete body["tag"];
  return body;
}

async function putLoadBalancer(ctx: DoServiceContext, id: string, mutate: (b: Json) => void) {
  const path = `/load_balancers/${idSegment(id)}` as const;
  const current = await ctx.api.get(path);
  const body = loadBalancerPutBody(current.load_balancer ?? {});
  mutate(body);
  // Echoes whatever the GET returned, so nothing here can check it against the PUT schema.
  const data = await ctx.api.written<"loadBalancers_update">(path, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return data.load_balancer ?? {};
}

// ── Firewalls ───────────────────────────────────────────────────────────

/** A firewall rule as the add/remove rule endpoints want it. */
function firewallRulesFromPrompt(values: Record<string, string>): DoFirewallRules {
  const protocol = values["protocol"] || "tcp";
  const addresses = parseIdList(values["addresses"]);
  const ports = protocol === "icmp" ? "0" : (values["ports"] ?? "").trim() || "0";
  const target = { addresses: addresses.length > 0 ? addresses : ["0.0.0.0/0", "::/0"] };
  const action = values["action"] === "deny" ? { action: "deny" } : {};
  return values["direction"] === "outbound"
    ? { outbound_rules: [{ protocol, ports, destinations: target, ...action }] }
    : { inbound_rules: [{ protocol, ports, sources: target, ...action }] };
}

// ── Update ──────────────────────────────────────────────────────────────

export async function updateDoServiceResource(
  ctx: DoServiceContext,
  typeId: string,
  resourceId: string,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance | null> {
  const id = externalIdOf(resourceId);
  const segment = idSegment(id);
  const has = (k: string) => fields[k] !== undefined;

  switch (typeId) {
    case "load-balancer": {
      const lb = await putLoadBalancer(ctx, id, (body) => {
        if (has("name")) body["name"] = fields["name"];
        if (has("sizeUnit")) body["size_unit"] = numberIn(fields["sizeUnit"], 1, 100, "Nodes");
        if (has("httpIdleTimeoutSeconds")) {
          body["http_idle_timeout_seconds"] = numberIn(
            fields["httpIdleTimeoutSeconds"],
            30,
            600,
            "HTTP idle timeout",
          );
        }
        if (has("redirectHttpToHttps")) {
          body["redirect_http_to_https"] = fields["redirectHttpToHttps"] === "true";
        }
        if (has("enableProxyProtocol")) {
          body["enable_proxy_protocol"] = fields["enableProxyProtocol"] === "true";
        }
        if (has("enableBackendKeepalive")) {
          body["enable_backend_keepalive"] = fields["enableBackendKeepalive"] === "true";
        }
        if (has("tlsCipherPolicy") && fields["tlsCipherPolicy"]) {
          body["tls_cipher_policy"] = fields["tlsCipherPolicy"];
        }
      });
      return mapLoadBalancer(lb, accountId);
    }
    case "firewall": {
      const current = await ctx.api.get(`/firewalls/${segment}`);
      const fw = current.firewall ?? {};
      const data = await ctx.api.put(`/firewalls/${segment}`, {
        body: {
          name: has("name") ? fields["name"] : fw.name,
          inbound_rules: arr(fw.inbound_rules),
          outbound_rules: arr(fw.outbound_rules),
          droplet_ids: arr(fw.droplet_ids),
          tags: arr(fw.tags),
        },
      });
      return mapFirewall(data.firewall ?? {}, accountId);
    }
    case "cdn-endpoint": {
      const data = await ctx.api.put(`/cdn/endpoints/${segment}`, {
        body: {
          ...(has("ttl") ? { ttl: Number(fields["ttl"]) } : {}),
          ...(has("customDomain") ? { custom_domain: fields["customDomain"] } : {}),
          ...(has("certificateId") ? { certificate_id: fields["certificateId"] } : {}),
        },
      });
      return mapCdnEndpoint(data.endpoint ?? {}, accountId);
    }
    case "uptime-check": {
      const current = await ctx.api.get(`/uptime/checks/${segment}`);
      const check = current.check ?? {};
      const regions = has("regions") ? parseIdList(fields["regions"]) : arr(check.regions);
      const valid = UPTIME_REGIONS.map((r) => r.id);
      const bad = regions.map(String).filter((r) => !valid.includes(r));
      if (bad.length > 0) {
        throw new Error(`Unknown region ${bad.join(", ")}. Use any of: ${valid.join(", ")}.`);
      }
      const data = await ctx.api.put(`/uptime/checks/${segment}`, {
        body: {
          name: has("name") ? fields["name"] : check.name,
          type: has("type") ? fields["type"] : check.type,
          target: has("target") ? fields["target"] : check.target,
          regions,
          enabled: has("enabled") ? fields["enabled"] === "true" : check.enabled !== false,
        },
      });
      return mapUptimeCheck(data.check ?? {}, accountId);
    }
    case "vpc-nat-gateway": {
      const current = await ctx.api.get(`/vpc_nat_gateways/${segment}`);
      const g = current.vpc_nat_gateway ?? {};
      const num = (
        k: string,
        apiKey: "udp_timeout_seconds" | "tcp_timeout_seconds" | "icmp_timeout_seconds",
      ) => (has(k) && fields[k] !== "" ? Number(fields[k]) : g[apiKey]);
      const data = await ctx.api.put(`/vpc_nat_gateways/${segment}`, {
        body: {
          name: has("name") ? fields["name"] : g.name,
          size: has("size") ? numberIn(fields["size"], 1, 5, "Size") : g.size,
          // The GET shape adds `gateway_ip`, which the update schema lacks.
          vpcs: arr(g.vpcs).map((v) => {
            // `default_gateway` is not on the document's GET shape.
            const vpc: Partial<typeof v> & { default_gateway?: boolean } = obj(v);
            return {
              ...(vpc.vpc_uuid !== undefined ? { vpc_uuid: vpc.vpc_uuid } : {}),
              ...(vpc.subnet_uuid ? { subnet_uuid: vpc.subnet_uuid } : {}),
              ...(typeof vpc.default_gateway === "boolean"
                ? { default_gateway: vpc.default_gateway }
                : {}),
            };
          }),
          udp_timeout_seconds: num("udpTimeoutSeconds", "udp_timeout_seconds"),
          tcp_timeout_seconds: num("tcpTimeoutSeconds", "tcp_timeout_seconds"),
          icmp_timeout_seconds: num("icmpTimeoutSeconds", "icmp_timeout_seconds"),
        },
      });
      return mapVpcNatGateway(data.vpc_nat_gateway ?? {}, accountId);
    }
    case "vpc-peering": {
      const data = await ctx.api.patch(`/vpc_peerings/${segment}`, {
        body: { name: fields["name"] },
      });
      return mapVpcPeering(data.vpc_peering ?? {}, accountId);
    }
    case "autoscale-pool": {
      const path = `/droplets/autoscale/${segment}` as const;
      const current = await ctx.api.get(path);
      const pool: Partial<NonNullable<typeof current.autoscale_pool>> =
        current.autoscale_pool ?? {};
      const before: DoPoolConfig = obj(pool.config);
      const mode =
        fields["mode"] || (before.target_number_instances != null ? "static" : "dynamic");
      const pick = (k: string, apiKey: keyof DoPoolConfig) =>
        has(k) ? fields[k] : before[apiKey] == null ? "" : String(before[apiKey]);
      let config: DoPoolConfig;
      if (mode === "static") {
        config = {
          target_number_instances: numberIn(
            pick("targetNumberInstances", "target_number_instances") ||
              String(pool.active_resources_count ?? 1),
            1,
            1000,
            "Fixed Droplet count",
          ),
        };
      } else {
        config = {
          min_instances: numberIn(pick("minInstances", "min_instances"), 1, 500, "Min Droplets"),
          max_instances: numberIn(pick("maxInstances", "max_instances"), 1, 1000, "Max Droplets"),
        };
        // Targets are fractions on the wire and percentages in the form.
        const target = (k: string, apiKey: keyof DoPoolConfig, label: string) => {
          if (has(k)) {
            if (!fields[k]) return undefined;
            return numberIn(fields[k], 5, 100, label) / 100;
          }
          return before[apiKey] == null ? undefined : Number(before[apiKey]);
        };
        const cpu = target("targetCpuUtilization", "target_cpu_utilization", "Target CPU");
        const mem = target("targetMemoryUtilization", "target_memory_utilization", "Target memory");
        if (cpu === undefined && mem === undefined) {
          throw new Error("A dynamic pool needs a target CPU or memory utilisation.");
        }
        if (cpu !== undefined) config.target_cpu_utilization = cpu;
        if (mem !== undefined) config.target_memory_utilization = mem;
        const cooldown = pick("cooldownMinutes", "cooldown_minutes");
        if (cooldown) config.cooldown_minutes = numberIn(cooldown, 5, 20, "Cooldown");
        if (Number(config.min_instances) > Number(config.max_instances)) {
          throw new Error("Min Droplets can't exceed Max Droplets.");
        }
      }
      const body = { name: pool.name, config, droplet_template: obj(pool.droplet_template) };
      // The template is echoed from the GET, which may be missing what the PUT requires.
      const data = await ctx.api.written<"autoscalepools_update">(path, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      return mapAutoscalePool(data.autoscale_pool ?? {}, accountId);
    }
    default:
      return null;
  }
}

// ── Delete ──────────────────────────────────────────────────────────────

const DELETERS: Record<string, (api: DoApi, id: NoSlashString) => Promise<unknown>> = {
  "load-balancer": (api, id) => api.delete(`/load_balancers/${id}`),
  firewall: (api, id) => api.delete(`/firewalls/${id}`),
  certificate: (api, id) => api.delete(`/certificates/${id}`),
  "cdn-endpoint": (api, id) => api.delete(`/cdn/endpoints/${id}`),
  "uptime-check": (api, id) => api.delete(`/uptime/checks/${id}`),
  "vpc-nat-gateway": (api, id) => api.delete(`/vpc_nat_gateways/${id}`),
  "vpc-peering": (api, id) => api.delete(`/vpc_peerings/${id}`),
  app: (api, id) => api.delete(`/apps/${id}`),
  // Deletes the pool only; its Droplets keep running. The detail page has a
  // separate "Delete pool and Droplets" action for the dangerous variant.
  "autoscale-pool": (api, id) => api.delete(`/droplets/autoscale/${id}`),
};

/** Returns false when `typeId` is not one of this module's types. */
export async function deleteDoServiceResource(
  ctx: DoServiceContext,
  typeId: string,
  resourceId: string,
): Promise<boolean> {
  const remove = DELETERS[typeId];
  if (!remove) return false;
  await remove(ctx.api, idSegment(externalIdOf(resourceId)));
  return true;
}

// ── Header actions (parameterless) ──────────────────────────────────────

export async function invokeDoServiceAction(
  ctx: DoServiceContext,
  typeId: string,
  resourceId: string,
  actionId: string,
): Promise<boolean> {
  const id = idSegment(externalIdOf(resourceId));
  if (typeId === "app") {
    switch (actionId) {
      case "app-deploy":
      case "app-force-rebuild":
        await ctx.api.post(`/apps/${id}/deployments`, {
          body: { force_build: actionId === "app-force-rebuild" },
        });
        return true;
      case "app-restart":
        await ctx.api.post(`/apps/${id}/restart`, { body: {} });
        return true;
      case "app-cancel-deployment": {
        const app = await ctx.api.get(`/apps/${id}`);
        const deploymentId = String(
          obj(app.app?.in_progress_deployment).id ?? obj(app.app?.pending_deployment).id ?? "",
        );
        if (!deploymentId) throw new Error("This app has no deployment in progress.");
        await ctx.api.post(`/apps/${id}/deployments/${idSegment(deploymentId)}/cancel`);
        return true;
      }
      case "app-commit-rollback":
        await ctx.api.post(`/apps/${id}/rollback/commit`);
        return true;
      case "app-revert-rollback":
        await ctx.api.post(`/apps/${id}/rollback/revert`);
        return true;
    }
  }
  if (
    typeId === "uptime-check" &&
    (actionId === "uptime-enable" || actionId === "uptime-disable")
  ) {
    const current = await ctx.api.get(`/uptime/checks/${id}`);
    const c = current.check ?? {};
    await ctx.api.put(`/uptime/checks/${id}`, {
      body: {
        name: c.name,
        type: c.type,
        target: c.target,
        regions: c.regions,
        enabled: actionId === "uptime-enable",
      },
    });
    return true;
  }
  if (typeId === "autoscale-pool" && actionId === "autoscale-delete-with-droplets") {
    await ctx.api.delete(`/droplets/autoscale/${id}/dangerous`, {
      headers: { "X-Dangerous": "true" },
    });
    return true;
  }
  return false;
}

// ── Prompt commands ─────────────────────────────────────────────────────

/** A rule the remove picker carries: exactly what DO returned, so it goes back as it came. */
function parseRule<Rule>(text: string): Rule {
  const rule: Rule | null = JSON.parse(text);
  if (!rule) throw new Error("Pick the rule to remove.");
  return rule;
}

/** Returns `undefined` when the command is not one of ours. */
export async function executeDoServiceCommand(
  ctx: DoServiceContext,
  typeId: string,
  resourceId: string,
  command: string,
  args: (string | number)[],
): Promise<unknown> {
  const id = externalIdOf(resourceId);
  const segment = idSegment(id);
  const values = parsePromptArgs(args);
  const ids = (key: string) => parseIdList(values[key]);

  if (typeId === "load-balancer") {
    switch (command) {
      case "lb-add-droplets":
      case "lb-remove-droplets": {
        const dropletIds = ids("dropletIds").map(Number).filter(Number.isFinite);
        if (dropletIds.length === 0) throw new Error("Pick at least one Droplet.");
        const body = { droplet_ids: dropletIds };
        const path = `/load_balancers/${segment}/droplets` as const;
        await (command === "lb-add-droplets"
          ? ctx.api.post(path, { body })
          : ctx.api.delete(path, { body }));
        return { ok: true };
      }
      case "lb-add-rule": {
        const entry = values["entryProtocol"] || "http";
        const base = {
          entry_protocol: entry,
          entry_port: numberIn(values["entryPort"], 1, 65535, "Entry port"),
          target_protocol: values["targetProtocol"] || "http",
          target_port: numberIn(values["targetPort"], 1, 65535, "Target port"),
        };
        let rule: DoForwardingRule = base;
        if (values["tlsPassthrough"] === "true") rule = { ...base, tls_passthrough: true };
        else if (["https", "http2", "http3"].includes(entry)) {
          if (!values["certificateId"]) {
            throw new Error("A TLS entry protocol needs a certificate or TLS passthrough.");
          }
          rule = { ...base, certificate_id: values["certificateId"] };
        }
        await ctx.api.post(`/load_balancers/${segment}/forwarding_rules`, {
          body: { forwarding_rules: [rule] },
        });
        return { ok: true };
      }
      case "lb-remove-rule": {
        const rule: DoForwardingRule | null = JSON.parse(values["rule"] || "null");
        if (!rule) throw new Error("Pick the rule to remove.");
        await ctx.api.delete(`/load_balancers/${segment}/forwarding_rules`, {
          body: { forwarding_rules: [rule] },
        });
        return { ok: true };
      }
      case "lb-health-check": {
        const protocol = values["protocol"] || "http";
        await putLoadBalancer(ctx, id, (body) => {
          body["health_check"] = {
            protocol,
            port: numberIn(values["port"], 1, 65535, "Port"),
            ...(protocol === "tcp" ? {} : { path: values["path"] || "/" }),
            check_interval_seconds: numberIn(values["checkIntervalSeconds"], 3, 300, "Interval"),
            response_timeout_seconds: numberIn(values["responseTimeoutSeconds"], 3, 300, "Timeout"),
            unhealthy_threshold: numberIn(
              values["unhealthyThreshold"],
              2,
              10,
              "Unhealthy threshold",
            ),
            healthy_threshold: numberIn(values["healthyThreshold"], 2, 10, "Healthy threshold"),
          };
        });
        return { ok: true };
      }
    }
  }

  if (typeId === "firewall") {
    switch (command) {
      case "fw-add-rule":
      case "fw-remove-rule": {
        const path = `/firewalls/${segment}/rules` as const;
        if (command === "fw-add-rule") {
          await ctx.api.post(path, { body: firewallRulesFromPrompt(values) });
          return { ok: true };
        }
        // The remove picker's option id is `{direction}:{rule JSON}`, the
        // exact rule DO returned, which the DELETE must match.
        const raw = values["rule"] ?? "";
        const sep = raw.indexOf(":");
        const text = raw.slice(sep + 1) || "null";
        const body: DoFirewallRules =
          raw.slice(0, sep) === "outbound"
            ? { outbound_rules: [parseRule<DoOutboundRule>(text)] }
            : { inbound_rules: [parseRule<DoInboundRule>(text)] };
        await ctx.api.delete(path, { body });
        return { ok: true };
      }
      case "fw-add-droplets":
      case "fw-remove-droplets": {
        const dropletIds = ids("dropletIds").map(Number).filter(Number.isFinite);
        if (dropletIds.length === 0) throw new Error("Pick at least one Droplet.");
        const body = { droplet_ids: dropletIds };
        const path = `/firewalls/${segment}/droplets` as const;
        await (command === "fw-add-droplets"
          ? ctx.api.post(path, { body })
          : ctx.api.delete(path, { body }));
        return { ok: true };
      }
      case "fw-add-tags":
      case "fw-remove-tags": {
        const tags = ids("tags");
        if (tags.length === 0) throw new Error("Pick at least one tag.");
        const path = `/firewalls/${segment}/tags` as const;
        await (command === "fw-add-tags"
          ? ctx.api.post(path, { body: { tags } })
          : ctx.api.delete(path, { body: { tags } }));
        return { ok: true };
      }
    }
  }

  if (typeId === "cdn-endpoint") {
    if (command === "cdn-purge") {
      const files = ids("files");
      await ctx.api.delete(`/cdn/endpoints/${segment}/cache`, {
        body: { files: files.length > 0 ? files : ["*"] },
      });
      return { ok: true };
    }
    if (command === "cdn-custom-domain") {
      const domain = (values["customDomain"] ?? "").trim();
      if (domain && !values["certificateId"]) {
        throw new Error("A custom domain needs a certificate that covers it.");
      }
      // Clearing the domain is how DO removes it: send empty strings.
      await ctx.api.put(`/cdn/endpoints/${segment}`, {
        body: {
          custom_domain: domain,
          certificate_id: domain ? values["certificateId"] : "",
        },
      });
      return { ok: true };
    }
  }

  if (typeId === "uptime-check") {
    if (command === "uptime-add-alert") {
      const type = values["type"] || "down";
      const slackUrl = (values["slackUrl"] ?? "").trim();
      await ctx.api.post(`/uptime/checks/${segment}/alerts`, {
        body: {
          name: values["name"] || `${type} alert`,
          type,
          period: values["period"] || "2m",
          notifications: {
            email: ids("emails"),
            slack: slackUrl
              ? [{ url: slackUrl, channel: values["slackChannel"] || "#alerts" }]
              : [],
          },
          // `down` / `down_global` have no threshold; latency and SSL expiry do.
          ...(type === "latency" || type === "ssl_expiry"
            ? {
                threshold: Number(values["threshold"] || (type === "latency" ? 1000 : 30)),
                comparison: type === "latency" ? "greater_than" : "less_than",
              }
            : {}),
        },
      });
      return { ok: true };
    }
    if (command === "uptime-delete-alert") {
      const alertId = values["alertId"] ?? "";
      if (!alertId) throw new Error("Missing alert id.");
      await ctx.api.delete(`/uptime/checks/${segment}/alerts/${idSegment(alertId)}`);
      return { ok: true };
    }
  }

  if (typeId === "app") {
    if (command === "app-rollback") {
      const deploymentId = values["deploymentId"] ?? "";
      if (!deploymentId) throw new Error("Pick the deployment to roll back to.");
      await ctx.api.post(`/apps/${segment}/rollback`, {
        // Pinning blocks Auto Deploy on push until the rollback is committed
        // or reverted; the detail page offers both while the app is pinned.
        body: { deployment_id: deploymentId, skip_pin: values["pin"] !== "true" },
      });
      return { ok: true };
    }
    if (command === "app-restart-components") {
      const components = ids("components");
      await ctx.api.post(`/apps/${segment}/restart`, {
        body: components.length > 0 ? { components } : {},
      });
      return { ok: true };
    }
  }

  return undefined;
}

// ── Detail enrichment ───────────────────────────────────────────────────

async function droplets(ctx: DoServiceContext): Promise<DoDropletRow[]> {
  const data = await ctx.api
    .get("/droplets", { query: { per_page: 200 } })
    .catch(() => ({ droplets: [] }));
  return data.droplets ?? [];
}

function dropletOption(d: DoDropletRow) {
  const slug = String(obj(d.region).slug ?? "");
  return {
    id: String(d.id ?? ""),
    label: slug ? `${String(d.name ?? d.id)} (${slug})` : String(d.name ?? d.id),
    region: slug,
  };
}

/**
 * Pre-fetch what each type's prompts and tables need so the renderer stays
 * synchronous. Everything lands in `resolvedOutputs` under `__x__` keys and
 * is best-effort: a failed side call leaves its section empty.
 */
export async function enrichDoServiceDetail(
  ctx: DoServiceContext,
  resource: ResourceInstance,
): Promise<ResourceInstance> {
  const id = resource.externalId ?? externalIdOf(resource.id);
  const segment = idSegment(id);
  const extra: Record<string, string> = {};
  const safe = async <T>(p: Promise<T>, fallback: Partial<T>): Promise<Partial<T>> =>
    p.catch(() => fallback);
  const page = { query: { per_page: 200 } };

  switch (resource.resourceTypeId) {
    case "load-balancer": {
      const [all, certs] = await Promise.all([
        droplets(ctx),
        safe(ctx.api.get("/certificates", page), { certificates: [] }),
      ]);
      const region = String(resource.fields["region"] ?? "");
      extra["__droplets__"] = JSON.stringify(
        all.map(dropletOption).filter((d) => !region || d.region === region),
      );
      extra["__certificates__"] = JSON.stringify(
        (certs.certificates ?? []).map((c) => ({
          id: String(c.id ?? ""),
          label: String(c.name ?? c.id),
        })),
      );
      break;
    }
    case "firewall": {
      const [all, tags] = await Promise.all([
        droplets(ctx),
        safe(ctx.api.get("/tags", page), { tags: [] }),
      ]);
      extra["__droplets__"] = JSON.stringify(all.map(dropletOption));
      extra["__tags__"] = JSON.stringify(
        (tags.tags ?? []).map((t) => String(t.name ?? "")).filter(Boolean),
      );
      break;
    }
    case "cdn-endpoint": {
      const certs = await safe(ctx.api.get("/certificates", page), { certificates: [] });
      extra["__certificates__"] = JSON.stringify(
        (certs.certificates ?? []).map((c) => ({
          id: String(c.id ?? ""),
          label: String(c.name ?? c.id),
        })),
      );
      break;
    }
    case "uptime-check": {
      const [state, alerts] = await Promise.all([
        safe(ctx.api.get(`/uptime/checks/${segment}/state`), { state: {} }),
        safe(ctx.api.get(`/uptime/checks/${segment}/alerts`, page), { alerts: [] }),
      ]);
      extra["__state__"] = JSON.stringify(state.state ?? {});
      extra["__alerts__"] = JSON.stringify(alerts.alerts ?? []);
      break;
    }
    case "app": {
      const [app, deployments] = await Promise.all([
        safe(ctx.api.get(`/apps/${segment}`), {}),
        safe(ctx.api.get(`/apps/${segment}/deployments`, { query: { per_page: 20 } }), {
          deployments: [],
        }),
      ]);
      extra["__deployments__"] = JSON.stringify(
        (deployments.deployments ?? []).map((d) => ({
          id: String(d.id ?? ""),
          phase: String(d.phase ?? ""),
          cause: String(d.cause ?? ""),
          createdAt: String(d.created_at ?? ""),
        })),
      );
      extra["__pinned__"] = String(obj(app.app?.pinned_deployment).id ?? "");
      extra["__domains__"] = JSON.stringify(
        arr(app.app?.domains).map((d) => ({
          domain: String(obj(obj(d).spec).domain ?? ""),
          phase: String(obj(d).phase ?? ""),
        })),
      );
      break;
    }
    case "autoscale-pool": {
      const [members, history] = await Promise.all([
        safe(ctx.api.get(`/droplets/autoscale/${segment}/members`, page), { droplets: [] }),
        safe(ctx.api.get(`/droplets/autoscale/${segment}/history`, { query: { per_page: 20 } }), {
          history: [],
        }),
      ]);
      extra["__members__"] = JSON.stringify(members.droplets ?? []);
      extra["__history__"] = JSON.stringify(history.history ?? []);
      break;
    }
    default:
      return resource;
  }
  return { ...resource, resolvedOutputs: { ...resource.resolvedOutputs, ...extra } };
}

// ── App Platform logs and spec ──────────────────────────────────────────

export const APP_LOG_TYPES = ["RUN", "BUILD", "DEPLOY", "RUN_RESTARTED"] as const;

/**
 * App logs. `/v2/apps/{id}/logs` doesn't return log lines: it returns
 * pre-signed `historic_urls` (plus a websocket `live_url` this poller can't
 * follow), so we fetch those archives and tail them. The "container"
 * dropdown picks the log type.
 */
export async function fetchDoAppLogs(
  ctx: DoServiceContext,
  resourceId: string,
  params: { tailLines?: number; container?: string },
): Promise<{ text: string; containers: string[]; activeContainer: string }> {
  const id = externalIdOf(resourceId);
  const logTypes: readonly string[] = APP_LOG_TYPES;
  const requested = params.container ?? "";
  const type = logTypes.includes(requested) ? requested : "RUN";
  const tail = params.tailLines ?? 200;
  const containers = [...APP_LOG_TYPES];
  let resp: DoResponse<"apps_get_logs_active_deployment_aggregate">;
  try {
    // `tail_lines` is not in the document, so the typed client would not take it.
    resp = await ctx.api.written<"apps_get_logs_active_deployment_aggregate">(
      `/apps/${idSegment(id)}/logs?type=${type}&follow=false&tail_lines=${encodeURIComponent(tail)}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      text: `Couldn't load ${type} logs: ${message}\n`,
      containers,
      activeContainer: type,
    };
  }
  const urls = (resp.historic_urls ?? []).filter((u) => /^https?:\/\//.test(u));
  const chunks = await Promise.all(
    urls.map(async (u) => {
      try {
        const res = await ctx.api.fetch(u);
        return res.ok ? await res.text() : "";
      } catch {
        return "";
      }
    }),
  );
  const lines = chunks.join("\n").split("\n").filter(Boolean).slice(-tail);
  const text =
    lines.length > 0
      ? `${lines.join("\n")}\n`
      : `No ${type} logs available for the active deployment yet.\n`;
  return { text, containers, activeContainer: type };
}

/** The app spec as pretty JSON, for the Spec tab. */
export async function getDoAppSpec(ctx: DoServiceContext, resourceId: string): Promise<string> {
  const data = await ctx.api.get(`/apps/${idSegment(externalIdOf(resourceId))}`);
  return JSON.stringify(obj(data.app?.spec), null, 2);
}

/**
 * Apply an edited spec. DO validates it server-side and starts a deployment
 * when it changed; a malformed spec comes back as a 400 that surfaces as is.
 */
export async function applyDoAppSpec(
  ctx: DoServiceContext,
  resourceId: string,
  manifest: string,
): Promise<void> {
  let spec: ApiBody<operations["apps_update"]>["spec"];
  try {
    spec = JSON.parse(manifest);
  } catch {
    throw new Error("The app spec must be valid JSON.");
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("The app spec must be a JSON object.");
  }
  await ctx.api.put(`/apps/${idSegment(externalIdOf(resourceId))}`, { body: { spec } });
}

// ── Metrics ─────────────────────────────────────────────────────────────

/**
 * Fetch one `/v2/monitoring/metrics/...` series family. Endpoints such as
 * `frontend_http_responses` return one series per status class (or per
 * Droplet), so with `split` every result becomes its own `MetricSeries`,
 * labelled by the Prometheus label values that tell the results apart. DO
 * doesn't document those label names, so they are discovered rather than
 * hard-coded.
 */
async function promSeries(
  request: () => Promise<PromResponse>,
  label: string,
  unit: string,
  split = false,
): Promise<MetricSeries[]> {
  try {
    const resp = await request();
    const results = (resp.data?.result ?? []).filter((r) => (r.values ?? []).length > 0);
    const varying = new Set<string>();
    if (split && results.length > 1) {
      const keys = new Set(results.flatMap((r) => Object.keys(r.metric ?? {})));
      for (const key of keys) {
        const seen = new Set(results.map((r) => r.metric?.[key] ?? ""));
        if (seen.size > 1) varying.add(key);
      }
    }
    const out: MetricSeries[] = [];
    for (const r of split ? results : results.slice(0, 1)) {
      const suffix = [...varying]
        .map((k) => r.metric?.[k] ?? "")
        .filter(Boolean)
        .join(" ");
      out.push({
        label: suffix ? `${label} (${suffix})` : label,
        unit,
        points: (r.values ?? []).map(([ts, v]) => ({
          timestamp: Number(ts) * 1000,
          value: Number(v),
        })),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Load balancer metrics: every `/monitoring/metrics/load_balancer/*` family. */
const LB_METRICS: Array<{
  name: MetricName<"load_balancer">;
  label: string;
  unit: string;
  split?: boolean;
}> = [
  { name: "frontend_http_requests_per_second", label: "Requests/s", unit: "req/s" },
  { name: "frontend_http_responses", label: "Responses", unit: "resp/s", split: true },
  { name: "frontend_connections_current", label: "Connections", unit: "" },
  { name: "frontend_connections_limit", label: "Connection Limit", unit: "" },
  { name: "frontend_cpu_utilization", label: "LB CPU", unit: "%" },
  { name: "frontend_network_throughput_http", label: "HTTP Throughput", unit: "bytes/s" },
  { name: "frontend_network_throughput_tcp", label: "TCP Throughput", unit: "bytes/s" },
  { name: "frontend_network_throughput_udp", label: "UDP Throughput", unit: "bytes/s" },
  { name: "frontend_nlb_tcp_network_throughput", label: "NLB TCP Throughput", unit: "bytes/s" },
  { name: "frontend_nlb_udp_network_throughput", label: "NLB UDP Throughput", unit: "bytes/s" },
  { name: "frontend_tls_connections_current", label: "TLS Connections", unit: "conn/s" },
  { name: "frontend_tls_connections_limit", label: "TLS Connection Limit", unit: "conn/s" },
  {
    name: "frontend_tls_connections_exceeding_rate_limit",
    label: "TLS Over Rate Limit",
    unit: "conn/s",
  },
  { name: "frontend_firewall_dropped_bytes", label: "Firewall Dropped", unit: "bytes" },
  { name: "frontend_firewall_dropped_packets", label: "Firewall Dropped Packets", unit: "" },
  { name: "droplets_http_response_time_avg", label: "Response Time (avg)", unit: "s" },
  { name: "droplets_http_response_time_50p", label: "Response Time (p50)", unit: "s" },
  { name: "droplets_http_response_time_95p", label: "Response Time (p95)", unit: "s" },
  { name: "droplets_http_response_time_99p", label: "Response Time (p99)", unit: "s" },
  { name: "droplets_http_session_duration_avg", label: "Session Duration (avg)", unit: "s" },
  { name: "droplets_http_session_duration_50p", label: "Session Duration (p50)", unit: "s" },
  { name: "droplets_http_session_duration_95p", label: "Session Duration (p95)", unit: "s" },
  { name: "droplets_queue_size", label: "Queue Size", unit: "" },
  { name: "droplets_connections", label: "Backend Connections", unit: "", split: true },
  {
    name: "droplets_http_responses",
    label: "Backend Responses",
    unit: "resp/s",
    split: true,
  },
  { name: "droplets_health_checks", label: "Health Checks", unit: "", split: true },
  { name: "droplets_downtime", label: "Downtime", unit: "s", split: true },
];

const AUTOSCALE_METRICS: Array<{
  name: MetricName<"droplet_autoscale">;
  label: string;
  unit: string;
}> = [
  { name: "current_instances", label: "Droplets", unit: "" },
  { name: "target_instances", label: "Target Droplets", unit: "" },
  { name: "current_cpu_utilization", label: "CPU Utilization", unit: "%" },
  { name: "target_cpu_utilization", label: "Target CPU", unit: "%" },
  { name: "current_memory_utilization", label: "Memory Utilization", unit: "%" },
  { name: "target_memory_utilization", label: "Target Memory", unit: "%" },
];

const APP_METRICS: Array<{ name: MetricName<"apps">; label: string; unit: string }> = [
  { name: "cpu_percentage", label: "CPU", unit: "%" },
  { name: "memory_percentage", label: "Memory", unit: "%" },
  { name: "restart_count", label: "Restarts", unit: "" },
];

/** Longest span of days the daily-bandwidth chart asks for, one call per day. */
const APP_BANDWIDTH_MAX_DAYS = 31;

/**
 * Egress per UTC day from `GET /v2/apps/{id}/metrics/bandwidth_daily?date=`,
 * which answers one day at a time (`bandwidth_bytes` is a uint64 string).
 * Days DO has no row for are skipped rather than charted as zero.
 */
async function appDailyBandwidth(
  ctx: DoServiceContext,
  appId: string,
  startMs: number,
  endMs: number,
): Promise<MetricSeries[]> {
  const DAY = 86_400_000;
  const days: number[] = [];
  for (let d = Math.floor(endMs / DAY) * DAY; d >= startMs - (startMs % DAY); d -= DAY) {
    days.push(d);
    if (days.length >= APP_BANDWIDTH_MAX_DAYS) break;
  }
  const points = await Promise.all(
    days.map(async (day) => {
      try {
        const resp = await ctx.api.get(`/apps/${idSegment(appId)}/metrics/bandwidth_daily`, {
          query: { date: new Date(day).toISOString() },
        });
        const row = (resp.app_bandwidth_usage ?? []).find((r) => !r.app_id || r.app_id === appId);
        const value = Number(row?.bandwidth_bytes);
        return row && Number.isFinite(value) ? { timestamp: day, value } : null;
      } catch {
        return null;
      }
    }),
  );
  const present = points
    .filter((p): p is { timestamp: number; value: number } => p !== null)
    .sort((a, b) => a.timestamp - b.timestamp);
  return present.length > 0 ? [{ label: "Bandwidth (daily)", unit: "bytes", points: present }] : [];
}

/** `null` when `typeId` has no metrics in this module. */
export async function fetchDoServiceMetrics(
  ctx: DoServiceContext,
  typeId: string,
  resourceId: string,
  resource: ResourceInstance | null,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[] | null> {
  const id = externalIdOf(resourceId);
  const now = Date.now();
  const start = String(Math.floor((timeRange?.startMs ?? now - 3_600_000) / 1000));
  const end = String(Math.floor((timeRange?.endMs ?? now) / 1000));
  const span = { start, end };

  if (typeId === "load-balancer") {
    const all = await Promise.all(
      LB_METRICS.map((m) =>
        promSeries(
          () =>
            ctx.api.get(`/monitoring/metrics/load_balancer/${m.name}`, {
              query: { lb_id: id, ...span },
            }),
          m.label,
          m.unit,
          m.split,
        ),
      ),
    );
    return all.flat();
  }
  if (typeId === "autoscale-pool") {
    const all = await Promise.all(
      AUTOSCALE_METRICS.map((m) =>
        promSeries(
          () =>
            ctx.api.get(`/monitoring/metrics/droplet_autoscale/${m.name}`, {
              query: { autoscale_pool_id: id, ...span },
            }),
          m.label,
          m.unit,
        ),
      ),
    );
    return all.flat();
  }
  if (typeId === "app") {
    // One series per component: `app_component` narrows the query, and the
    // app-wide call (no component) comes back split by component anyway on
    // multi-component apps, so ask per component when we know them.
    const components = String(resource?.fields["components"] ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    const targets = components.length > 0 ? components : [""];
    const bandwidth = appDailyBandwidth(
      ctx,
      id,
      timeRange?.startMs ?? now - 3_600_000,
      timeRange?.endMs ?? now,
    );
    const all = await Promise.all(
      targets.flatMap((component) =>
        APP_METRICS.map((m) =>
          promSeries(
            () =>
              ctx.api.get(`/monitoring/metrics/apps/${m.name}`, {
                query: {
                  app_id: id,
                  ...(component ? { app_component: component } : {}),
                  ...span,
                },
              }),
            component && targets.length > 1 ? `${m.label} (${component})` : m.label,
            m.unit,
          ),
        ),
      ),
    );
    return [...all.flat(), ...(await bandwidth)];
  }
  return null;
}
