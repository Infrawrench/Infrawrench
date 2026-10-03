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
import type { MetricSeries, ResourceInstance } from "@infrawrench/plugin-base";
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

export interface DoServiceContext {
  fetch<T>(path: string, options?: RequestInit): Promise<T>;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function obj(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function externalIdOf(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

function send(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: JSON_HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** Prompt values arrive JSON-encoded in `args[0]`. */
export function parsePromptArgs(args: (string | number)[]): Record<string, string> {
  const first = args[0];
  if (typeof first !== "string" || !first) return {};
  try {
    const parsed: unknown = JSON.parse(first);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed as Json).map(([k, v]) => [k, v == null ? "" : String(v)]),
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
export function loadBalancerPutBody(lb: Json): Json {
  const readOnly = ["id", "ip", "ipv6", "status", "created_at", "algorithm", "size"];
  const body: Json = {};
  for (const [k, v] of Object.entries(lb)) {
    if (!readOnly.includes(k) && v !== null && v !== undefined) body[k] = v;
  }
  const region = obj(lb["region"]);
  if (region["slug"]) body["region"] = region["slug"];
  if (lb["tag"]) delete body["droplet_ids"];
  else delete body["tag"];
  return body;
}

async function putLoadBalancer(ctx: DoServiceContext, id: string, mutate: (b: Json) => void) {
  const current = await ctx.fetch<{ load_balancer: Json }>(`/load_balancers/${id}`);
  const body = loadBalancerPutBody(current.load_balancer ?? {});
  mutate(body);
  const data = await ctx.fetch<{ load_balancer: Json }>(`/load_balancers/${id}`, send("PUT", body));
  return data.load_balancer ?? {};
}

// ── Firewalls ───────────────────────────────────────────────────────────

/** A firewall rule as the add/remove rule endpoints want it. */
function firewallRuleFromPrompt(values: Record<string, string>): {
  direction: "inbound" | "outbound";
  rule: Json;
} {
  const direction = values["direction"] === "outbound" ? "outbound" : "inbound";
  const protocol = values["protocol"] || "tcp";
  const addresses = parseIdList(values["addresses"]);
  const rule: Json = {
    protocol,
    ports: protocol === "icmp" ? "0" : (values["ports"] ?? "").trim() || "0",
    [direction === "inbound" ? "sources" : "destinations"]: {
      addresses: addresses.length > 0 ? addresses : ["0.0.0.0/0", "::/0"],
    },
  };
  if (values["action"] === "deny") rule["action"] = "deny";
  return { direction, rule };
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
      const current = await ctx.fetch<{ firewall: Json }>(`/firewalls/${id}`);
      const fw = current.firewall ?? {};
      const body: Json = {
        name: has("name") ? fields["name"] : fw["name"],
        inbound_rules: arr(fw["inbound_rules"]),
        outbound_rules: arr(fw["outbound_rules"]),
        droplet_ids: arr(fw["droplet_ids"]),
        tags: arr(fw["tags"]),
      };
      const data = await ctx.fetch<{ firewall: Json }>(`/firewalls/${id}`, send("PUT", body));
      return mapFirewall(data.firewall ?? {}, accountId);
    }
    case "cdn-endpoint": {
      const body: Json = {};
      if (has("ttl")) body["ttl"] = Number(fields["ttl"]);
      if (has("customDomain")) body["custom_domain"] = fields["customDomain"];
      if (has("certificateId")) body["certificate_id"] = fields["certificateId"];
      const data = await ctx.fetch<{ endpoint: Json }>(`/cdn/endpoints/${id}`, send("PUT", body));
      return mapCdnEndpoint(data.endpoint ?? {}, accountId);
    }
    case "uptime-check": {
      const current = await ctx.fetch<{ check: Json }>(`/uptime/checks/${id}`);
      const check = current.check ?? {};
      const regions = has("regions") ? parseIdList(fields["regions"]) : arr(check["regions"]);
      const valid = UPTIME_REGIONS.map((r) => r.id);
      const bad = regions.map(String).filter((r) => !valid.includes(r));
      if (bad.length > 0) {
        throw new Error(`Unknown region ${bad.join(", ")}. Use any of: ${valid.join(", ")}.`);
      }
      const body: Json = {
        name: has("name") ? fields["name"] : check["name"],
        type: has("type") ? fields["type"] : check["type"],
        target: has("target") ? fields["target"] : check["target"],
        regions,
        enabled: has("enabled") ? fields["enabled"] === "true" : check["enabled"] !== false,
      };
      const data = await ctx.fetch<{ check: Json }>(`/uptime/checks/${id}`, send("PUT", body));
      return mapUptimeCheck(data.check ?? {}, accountId);
    }
    case "vpc-nat-gateway": {
      const current = await ctx.fetch<{ vpc_nat_gateway: Json }>(`/vpc_nat_gateways/${id}`);
      const g = current.vpc_nat_gateway ?? {};
      const num = (k: string, apiKey: string) =>
        has(k) && fields[k] !== "" ? Number(fields[k]) : g[apiKey];
      const body: Json = {
        name: has("name") ? fields["name"] : g["name"],
        size: has("size") ? numberIn(fields["size"], 1, 5, "Size") : g["size"],
        // The GET shape adds `gateway_ip`, which the update schema lacks.
        vpcs: arr(g["vpcs"]).map((v) => {
          const vpc = obj(v);
          return {
            vpc_uuid: vpc["vpc_uuid"],
            ...(vpc["subnet_uuid"] ? { subnet_uuid: vpc["subnet_uuid"] } : {}),
            ...(typeof vpc["default_gateway"] === "boolean"
              ? { default_gateway: vpc["default_gateway"] }
              : {}),
          };
        }),
        udp_timeout_seconds: num("udpTimeoutSeconds", "udp_timeout_seconds"),
        tcp_timeout_seconds: num("tcpTimeoutSeconds", "tcp_timeout_seconds"),
        icmp_timeout_seconds: num("icmpTimeoutSeconds", "icmp_timeout_seconds"),
      };
      const data = await ctx.fetch<{ vpc_nat_gateway: Json }>(
        `/vpc_nat_gateways/${id}`,
        send("PUT", body),
      );
      return mapVpcNatGateway(data.vpc_nat_gateway ?? {}, accountId);
    }
    case "vpc-peering": {
      const data = await ctx.fetch<{ vpc_peering: Json }>(
        `/vpc_peerings/${id}`,
        send("PATCH", { name: fields["name"] }),
      );
      return mapVpcPeering(data.vpc_peering ?? {}, accountId);
    }
    case "autoscale-pool": {
      const current = await ctx.fetch<{ autoscale_pool: Json }>(`/droplets/autoscale/${id}`);
      const pool = current.autoscale_pool ?? {};
      const before = obj(pool["config"]);
      const mode =
        fields["mode"] || (before["target_number_instances"] != null ? "static" : "dynamic");
      const pick = (k: string, apiKey: string) =>
        has(k) ? fields[k] : before[apiKey] == null ? "" : String(before[apiKey]);
      let config: Json;
      if (mode === "static") {
        config = {
          target_number_instances: numberIn(
            pick("targetNumberInstances", "target_number_instances") ||
              String(pool["active_resources_count"] ?? 1),
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
        const target = (k: string, apiKey: string, label: string) => {
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
        if (cpu !== undefined) config["target_cpu_utilization"] = cpu;
        if (mem !== undefined) config["target_memory_utilization"] = mem;
        const cooldown = pick("cooldownMinutes", "cooldown_minutes");
        if (cooldown) config["cooldown_minutes"] = numberIn(cooldown, 5, 20, "Cooldown");
        if (Number(config["min_instances"]) > Number(config["max_instances"])) {
          throw new Error("Min Droplets can't exceed Max Droplets.");
        }
      }
      const body = { name: pool["name"], config, droplet_template: obj(pool["droplet_template"]) };
      const data = await ctx.fetch<{ autoscale_pool: Json }>(
        `/droplets/autoscale/${id}`,
        send("PUT", body),
      );
      return mapAutoscalePool(data.autoscale_pool ?? {}, accountId);
    }
    default:
      return null;
  }
}

// ── Delete ──────────────────────────────────────────────────────────────

const DELETE_PATHS: Record<string, (id: string) => string> = {
  "load-balancer": (id) => `/load_balancers/${id}`,
  firewall: (id) => `/firewalls/${id}`,
  certificate: (id) => `/certificates/${id}`,
  "cdn-endpoint": (id) => `/cdn/endpoints/${id}`,
  "uptime-check": (id) => `/uptime/checks/${id}`,
  "vpc-nat-gateway": (id) => `/vpc_nat_gateways/${id}`,
  "vpc-peering": (id) => `/vpc_peerings/${id}`,
  app: (id) => `/apps/${id}`,
  // Deletes the pool only; its Droplets keep running. The detail page has a
  // separate "Delete pool and Droplets" action for the dangerous variant.
  "autoscale-pool": (id) => `/droplets/autoscale/${id}`,
};

/** Returns false when `typeId` is not one of this module's types. */
export async function deleteDoServiceResource(
  ctx: DoServiceContext,
  typeId: string,
  resourceId: string,
): Promise<boolean> {
  const path = DELETE_PATHS[typeId];
  if (!path) return false;
  await ctx.fetch<unknown>(path(externalIdOf(resourceId)), { method: "DELETE" });
  return true;
}

// ── Header actions (parameterless) ──────────────────────────────────────

export async function invokeDoServiceAction(
  ctx: DoServiceContext,
  typeId: string,
  resourceId: string,
  actionId: string,
): Promise<boolean> {
  const id = externalIdOf(resourceId);
  if (typeId === "app") {
    switch (actionId) {
      case "app-deploy":
      case "app-force-rebuild":
        await ctx.fetch<unknown>(
          `/apps/${id}/deployments`,
          send("POST", { force_build: actionId === "app-force-rebuild" }),
        );
        return true;
      case "app-restart":
        await ctx.fetch<unknown>(`/apps/${id}/restart`, send("POST", {}));
        return true;
      case "app-cancel-deployment": {
        const app = await ctx.fetch<{ app: Json }>(`/apps/${id}`);
        const deploymentId = String(
          obj(app.app?.["in_progress_deployment"])["id"] ??
            obj(app.app?.["pending_deployment"])["id"] ??
            "",
        );
        if (!deploymentId) throw new Error("This app has no deployment in progress.");
        await ctx.fetch<unknown>(`/apps/${id}/deployments/${deploymentId}/cancel`, send("POST"));
        return true;
      }
      case "app-commit-rollback":
        await ctx.fetch<unknown>(`/apps/${id}/rollback/commit`, send("POST"));
        return true;
      case "app-revert-rollback":
        await ctx.fetch<unknown>(`/apps/${id}/rollback/revert`, send("POST"));
        return true;
    }
  }
  if (
    typeId === "uptime-check" &&
    (actionId === "uptime-enable" || actionId === "uptime-disable")
  ) {
    const current = await ctx.fetch<{ check: Json }>(`/uptime/checks/${id}`);
    const c = current.check ?? {};
    await ctx.fetch<unknown>(
      `/uptime/checks/${id}`,
      send("PUT", {
        name: c["name"],
        type: c["type"],
        target: c["target"],
        regions: c["regions"],
        enabled: actionId === "uptime-enable",
      }),
    );
    return true;
  }
  if (typeId === "autoscale-pool" && actionId === "autoscale-delete-with-droplets") {
    await ctx.fetch<unknown>(`/droplets/autoscale/${id}/dangerous`, {
      method: "DELETE",
      headers: { "X-Dangerous": "true" },
    });
    return true;
  }
  return false;
}

// ── Prompt commands ─────────────────────────────────────────────────────

/** Returns `undefined` when the command is not one of ours. */
export async function executeDoServiceCommand(
  ctx: DoServiceContext,
  typeId: string,
  resourceId: string,
  command: string,
  args: (string | number)[],
): Promise<unknown> {
  const id = externalIdOf(resourceId);
  const values = parsePromptArgs(args);
  const ids = (key: string) => parseIdList(values[key]);

  if (typeId === "load-balancer") {
    switch (command) {
      case "lb-add-droplets":
      case "lb-remove-droplets": {
        const dropletIds = ids("dropletIds").map(Number).filter(Number.isFinite);
        if (dropletIds.length === 0) throw new Error("Pick at least one Droplet.");
        await ctx.fetch<unknown>(
          `/load_balancers/${id}/droplets`,
          send(command === "lb-add-droplets" ? "POST" : "DELETE", { droplet_ids: dropletIds }),
        );
        return { ok: true };
      }
      case "lb-add-rule": {
        const entry = values["entryProtocol"] || "http";
        const rule: Json = {
          entry_protocol: entry,
          entry_port: numberIn(values["entryPort"], 1, 65535, "Entry port"),
          target_protocol: values["targetProtocol"] || "http",
          target_port: numberIn(values["targetPort"], 1, 65535, "Target port"),
        };
        if (values["tlsPassthrough"] === "true") rule["tls_passthrough"] = true;
        else if (["https", "http2", "http3"].includes(entry)) {
          if (!values["certificateId"]) {
            throw new Error("A TLS entry protocol needs a certificate or TLS passthrough.");
          }
          rule["certificate_id"] = values["certificateId"];
        }
        await ctx.fetch<unknown>(
          `/load_balancers/${id}/forwarding_rules`,
          send("POST", { forwarding_rules: [rule] }),
        );
        return { ok: true };
      }
      case "lb-remove-rule": {
        const rule = JSON.parse(values["rule"] || "null") as Json | null;
        if (!rule) throw new Error("Pick the rule to remove.");
        await ctx.fetch<unknown>(
          `/load_balancers/${id}/forwarding_rules`,
          send("DELETE", { forwarding_rules: [rule] }),
        );
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
        let direction: "inbound" | "outbound";
        let rule: Json;
        if (command === "fw-add-rule") {
          ({ direction, rule } = firewallRuleFromPrompt(values));
        } else {
          // The remove picker's option id is `{direction}:{rule JSON}`, the
          // exact rule DO returned, which the DELETE must match.
          const raw = values["rule"] ?? "";
          const sep = raw.indexOf(":");
          direction = raw.slice(0, sep) === "outbound" ? "outbound" : "inbound";
          rule = JSON.parse(raw.slice(sep + 1) || "null") as Json;
          if (!rule) throw new Error("Pick the rule to remove.");
        }
        await ctx.fetch<unknown>(
          `/firewalls/${id}/rules`,
          send(command === "fw-add-rule" ? "POST" : "DELETE", {
            [direction === "inbound" ? "inbound_rules" : "outbound_rules"]: [rule],
          }),
        );
        return { ok: true };
      }
      case "fw-add-droplets":
      case "fw-remove-droplets": {
        const dropletIds = ids("dropletIds").map(Number).filter(Number.isFinite);
        if (dropletIds.length === 0) throw new Error("Pick at least one Droplet.");
        await ctx.fetch<unknown>(
          `/firewalls/${id}/droplets`,
          send(command === "fw-add-droplets" ? "POST" : "DELETE", { droplet_ids: dropletIds }),
        );
        return { ok: true };
      }
      case "fw-add-tags":
      case "fw-remove-tags": {
        const tags = ids("tags");
        if (tags.length === 0) throw new Error("Pick at least one tag.");
        await ctx.fetch<unknown>(
          `/firewalls/${id}/tags`,
          send(command === "fw-add-tags" ? "POST" : "DELETE", { tags }),
        );
        return { ok: true };
      }
    }
  }

  if (typeId === "cdn-endpoint") {
    if (command === "cdn-purge") {
      const files = ids("files");
      await ctx.fetch<unknown>(
        `/cdn/endpoints/${id}/cache`,
        send("DELETE", { files: files.length > 0 ? files : ["*"] }),
      );
      return { ok: true };
    }
    if (command === "cdn-custom-domain") {
      const domain = (values["customDomain"] ?? "").trim();
      if (domain && !values["certificateId"]) {
        throw new Error("A custom domain needs a certificate that covers it.");
      }
      // Clearing the domain is how DO removes it: send empty strings.
      await ctx.fetch<unknown>(
        `/cdn/endpoints/${id}`,
        send("PUT", {
          custom_domain: domain,
          certificate_id: domain ? values["certificateId"] : "",
        }),
      );
      return { ok: true };
    }
  }

  if (typeId === "uptime-check") {
    if (command === "uptime-add-alert") {
      const type = values["type"] || "down";
      const slackUrl = (values["slackUrl"] ?? "").trim();
      const body: Json = {
        name: values["name"] || `${type} alert`,
        type,
        period: values["period"] || "2m",
        notifications: {
          email: ids("emails"),
          slack: slackUrl ? [{ url: slackUrl, channel: values["slackChannel"] || "#alerts" }] : [],
        },
      };
      // `down` / `down_global` have no threshold; latency and SSL expiry do.
      if (type === "latency" || type === "ssl_expiry") {
        body["threshold"] = Number(values["threshold"] || (type === "latency" ? 1000 : 30));
        body["comparison"] = type === "latency" ? "greater_than" : "less_than";
      }
      await ctx.fetch<unknown>(`/uptime/checks/${id}/alerts`, send("POST", body));
      return { ok: true };
    }
    if (command === "uptime-delete-alert") {
      const alertId = values["alertId"] ?? "";
      if (!alertId) throw new Error("Missing alert id.");
      await ctx.fetch<unknown>(`/uptime/checks/${id}/alerts/${alertId}`, { method: "DELETE" });
      return { ok: true };
    }
  }

  if (typeId === "app") {
    if (command === "app-rollback") {
      const deploymentId = values["deploymentId"] ?? "";
      if (!deploymentId) throw new Error("Pick the deployment to roll back to.");
      await ctx.fetch<unknown>(
        `/apps/${id}/rollback`,
        // Pinning blocks Auto Deploy on push until the rollback is committed
        // or reverted; the detail page offers both while the app is pinned.
        send("POST", { deployment_id: deploymentId, skip_pin: values["pin"] !== "true" }),
      );
      return { ok: true };
    }
    if (command === "app-restart-components") {
      const components = ids("components");
      await ctx.fetch<unknown>(
        `/apps/${id}/restart`,
        send("POST", components.length > 0 ? { components } : {}),
      );
      return { ok: true };
    }
  }

  return undefined;
}

// ── Detail enrichment ───────────────────────────────────────────────────

async function droplets(ctx: DoServiceContext): Promise<Json[]> {
  const data = await ctx
    .fetch<{ droplets?: Json[] | null }>("/droplets?per_page=200")
    .catch(() => ({ droplets: [] as Json[] }));
  return data.droplets ?? [];
}

function dropletOption(d: Json) {
  const slug = String(obj(d["region"])["slug"] ?? "");
  return {
    id: String(d["id"] ?? ""),
    label: slug ? `${String(d["name"] ?? d["id"])} (${slug})` : String(d["name"] ?? d["id"]),
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
  const extra: Record<string, string> = {};
  const safe = async <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);

  switch (resource.resourceTypeId) {
    case "load-balancer": {
      const [all, certs] = await Promise.all([
        droplets(ctx),
        safe(ctx.fetch<{ certificates?: Json[] | null }>("/certificates?per_page=200"), {
          certificates: [],
        }),
      ]);
      const region = String(resource.fields["region"] ?? "");
      extra["__droplets__"] = JSON.stringify(
        all.map(dropletOption).filter((d) => !region || d.region === region),
      );
      extra["__certificates__"] = JSON.stringify(
        (certs.certificates ?? []).map((c) => ({
          id: String(c["id"] ?? ""),
          label: String(c["name"] ?? c["id"]),
        })),
      );
      break;
    }
    case "firewall": {
      const [all, tags] = await Promise.all([
        droplets(ctx),
        safe(ctx.fetch<{ tags?: Json[] | null }>("/tags?per_page=200"), { tags: [] }),
      ]);
      extra["__droplets__"] = JSON.stringify(all.map(dropletOption));
      extra["__tags__"] = JSON.stringify(
        (tags.tags ?? []).map((t) => String(t["name"] ?? "")).filter(Boolean),
      );
      break;
    }
    case "cdn-endpoint": {
      const certs = await safe(
        ctx.fetch<{ certificates?: Json[] | null }>("/certificates?per_page=200"),
        { certificates: [] },
      );
      extra["__certificates__"] = JSON.stringify(
        (certs.certificates ?? []).map((c) => ({
          id: String(c["id"] ?? ""),
          label: String(c["name"] ?? c["id"]),
        })),
      );
      break;
    }
    case "uptime-check": {
      const [state, alerts] = await Promise.all([
        safe(ctx.fetch<{ state?: Json }>(`/uptime/checks/${id}/state`), { state: {} }),
        safe(ctx.fetch<{ alerts?: Json[] | null }>(`/uptime/checks/${id}/alerts?per_page=200`), {
          alerts: [],
        }),
      ]);
      extra["__state__"] = JSON.stringify(state.state ?? {});
      extra["__alerts__"] = JSON.stringify(alerts.alerts ?? []);
      break;
    }
    case "app": {
      const [app, deployments] = await Promise.all([
        safe(ctx.fetch<{ app?: Json }>(`/apps/${id}`), { app: {} }),
        safe(ctx.fetch<{ deployments?: Json[] | null }>(`/apps/${id}/deployments?per_page=20`), {
          deployments: [],
        }),
      ]);
      extra["__deployments__"] = JSON.stringify(
        (deployments.deployments ?? []).map((d) => ({
          id: String(d["id"] ?? ""),
          phase: String(d["phase"] ?? ""),
          cause: String(d["cause"] ?? ""),
          createdAt: String(d["created_at"] ?? ""),
        })),
      );
      extra["__pinned__"] = String(obj(app.app?.["pinned_deployment"])["id"] ?? "");
      extra["__domains__"] = JSON.stringify(
        arr(app.app?.["domains"]).map((d) => ({
          domain: String(obj(obj(d)["spec"])["domain"] ?? ""),
          phase: String(obj(d)["phase"] ?? ""),
        })),
      );
      break;
    }
    case "autoscale-pool": {
      const [members, history] = await Promise.all([
        safe(
          ctx.fetch<{ droplets?: Json[] | null }>(`/droplets/autoscale/${id}/members?per_page=200`),
          { droplets: [] },
        ),
        safe(
          ctx.fetch<{ history?: Json[] | null }>(`/droplets/autoscale/${id}/history?per_page=20`),
          { history: [] },
        ),
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
  const type = (APP_LOG_TYPES as readonly string[]).includes(params.container ?? "")
    ? (params.container as string)
    : "RUN";
  const tail = params.tailLines ?? 200;
  const containers = [...APP_LOG_TYPES];
  let resp: { historic_urls?: string[] | null; live_url?: string };
  try {
    resp = await ctx.fetch(`/apps/${id}/logs?type=${type}&follow=false&tail_lines=${tail}`);
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
        const res = await fetch(u);
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
  const data = await ctx.fetch<{ app?: Json }>(`/apps/${externalIdOf(resourceId)}`);
  return JSON.stringify(obj(data.app?.["spec"]), null, 2);
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
  let spec: unknown;
  try {
    spec = JSON.parse(manifest);
  } catch {
    throw new Error("The app spec must be valid JSON.");
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("The app spec must be a JSON object.");
  }
  await ctx.fetch<unknown>(`/apps/${externalIdOf(resourceId)}`, send("PUT", { spec }));
}

// ── Metrics ─────────────────────────────────────────────────────────────

interface PromResponse {
  data?: { result?: Array<{ metric?: Record<string, string>; values?: [number, string][] }> };
}

/**
 * Fetch one `/v2/monitoring/metrics/...` series family. Endpoints such as
 * `frontend_http_responses` return one series per status class (or per
 * Droplet), so with `split` every result becomes its own `MetricSeries`,
 * labelled by the Prometheus label values that tell the results apart. DO
 * doesn't document those label names, so they are discovered rather than
 * hard-coded.
 */
async function promSeries(
  ctx: DoServiceContext,
  path: string,
  label: string,
  unit: string,
  split = false,
): Promise<MetricSeries[]> {
  try {
    const resp = await ctx.fetch<PromResponse>(path);
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
        points: (r.values ?? []).map(([ts, v]) => ({ timestamp: ts * 1000, value: Number(v) })),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Load balancer metrics: every `/monitoring/metrics/load_balancer/*` family. */
const LB_METRICS: Array<{ name: string; label: string; unit: string; split?: boolean }> = [
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

const AUTOSCALE_METRICS = [
  { name: "current_instances", label: "Droplets", unit: "" },
  { name: "target_instances", label: "Target Droplets", unit: "" },
  { name: "current_cpu_utilization", label: "CPU Utilization", unit: "%" },
  { name: "target_cpu_utilization", label: "Target CPU", unit: "%" },
  { name: "current_memory_utilization", label: "Memory Utilization", unit: "%" },
  { name: "target_memory_utilization", label: "Target Memory", unit: "%" },
];

const APP_METRICS = [
  { name: "cpu_percentage", label: "CPU", unit: "%" },
  { name: "memory_percentage", label: "Memory", unit: "%" },
  { name: "restart_count", label: "Restarts", unit: "" },
];

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
  const start = Math.floor((timeRange?.startMs ?? now - 3_600_000) / 1000);
  const end = Math.floor((timeRange?.endMs ?? now) / 1000);
  const window = `&start=${start}&end=${end}`;

  if (typeId === "load-balancer") {
    const all = await Promise.all(
      LB_METRICS.map((m) =>
        promSeries(
          ctx,
          `/monitoring/metrics/load_balancer/${m.name}?lb_id=${id}${window}`,
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
          ctx,
          `/monitoring/metrics/droplet_autoscale/${m.name}?autoscale_pool_id=${id}${window}`,
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
    const all = await Promise.all(
      targets.flatMap((component) =>
        APP_METRICS.map((m) =>
          promSeries(
            ctx,
            `/monitoring/metrics/apps/${m.name}?app_id=${id}${component ? `&app_component=${encodeURIComponent(component)}` : ""}${window}`,
            component && targets.length > 1 ? `${m.label} (${component})` : m.label,
            m.unit,
          ),
        ),
      ),
    );
    return all.flat();
  }
  return null;
}
