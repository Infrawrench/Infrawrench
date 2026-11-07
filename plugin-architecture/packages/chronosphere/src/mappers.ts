import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { Bucket, Collection, ConfigObjects, ConfigTypeId, Notifier } from "./api.js";
import type { components } from "./api-types.gen.js";

export const PLUGIN_ID = "chronosphere";

type Schemas = components["schemas"];
type FieldValue = string | number | boolean | undefined | null;

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, FieldValue>,
  outputs: Record<string, string | undefined> = {},
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  }
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) if (v) resolved[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: resolved,
    secretStates: [],
    externalId,
    createdAt: now,
    updatedAt: now,
  };
}

export const labelsText = (l: Record<string, string> | undefined): string =>
  Object.entries(l ?? {})
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(", ");

const OPS: Record<string, string> = {
  GEQ: ">=",
  GT: ">",
  LEQ: "<=",
  LT: "<",
  EQ: "==",
  NEQ: "!=",
  EXISTS: "exists",
  NOT_EXISTS: "not exists",
  SIGNAL_NOT_EXISTS: "no signal",
};

/** `warn: > 80 for 300s; critical: > 95 for 60s`. */
export function describeConditions(sc: Schemas["MonitorSeriesConditions"] | undefined): string {
  const parts: string[] = [];
  const severities: Array<"warn" | "critical"> = ["warn", "critical"];
  for (const sev of severities) {
    for (const c of sc?.defaults?.[sev]?.conditions ?? []) {
      const op = OPS[String(c.op)] ?? String(c.op ?? "?");
      const value = c.value !== undefined && !/exists|signal/.test(op) ? ` ${c.value}` : "";
      const sustain = c.sustain_secs ? ` for ${c.sustain_secs}s` : "";
      parts.push(`${sev}: ${op}${value}${sustain}`);
    }
  }
  const overrides = sc?.overrides?.length ?? 0;
  return parts.join("; ") + (overrides ? ` (+${overrides} overrides)` : "");
}

function routeTargets(r: Schemas["RoutesNotifierList"] | undefined): string {
  if (!r) return "";
  const out: string[] = [...(r.notifier_slugs ?? [])];
  for (const d of r.destinations ?? []) {
    if (d.email) out.push(`email ${(d.email.addresses ?? []).join(" ")}`);
    if (d.slack) out.push(`Slack ${(d.slack.channels ?? []).join(" ")}`);
    if (d.pagerduty) out.push("PagerDuty");
    if (d.webhook) out.push("webhook");
    if (d.ops_genie) out.push("OpsGenie");
    if (d.victor_ops) out.push("VictorOps");
  }
  return out.join(", ");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function notifierType(n: Notifier): { type: string; target: string } {
  if (n.slack) return { type: "Slack", target: String(n.slack.channel ?? "") };
  if (n.pagerduty) return { type: "PagerDuty", target: "" };
  if (n.ops_genie) return { type: "OpsGenie", target: "" };
  if (n.victor_ops) return { type: "VictorOps", target: String(n.victor_ops.routing_key ?? "") };
  if (n.email) return { type: "Email", target: String(n.email.to ?? "") };
  // Webhook URLs often carry a secret in the path or query: keep the host only.
  if (n.webhook) return { type: "Webhook", target: hostOf(String(n.webhook.url ?? "")) };
  if (n.discard) return { type: "Discard", target: "" };
  return { type: "Unknown", target: "" };
}

const filtersText = (filters: Schemas["configv1LabelFilter"][] | undefined): string =>
  (filters ?? []).map((x) => `${x.name}:${x.value_glob}`).join(" ");

/** What every config object answers with, read as loosely as the API allows. */
function identity(x: { slug?: string; name?: string; updated_at?: string }) {
  const slug = String(x.slug ?? "");
  const name = String(x.name ?? slug);
  return { slug, name, common: { slug, updatedAt: x.updated_at } };
}

function matcherText(m: Schemas["configv1MutingRuleLabelMatcher"]): string {
  const op =
    m.type === "NOT_EXACT"
      ? "!="
      : m.type === "REGEX"
        ? "=~"
        : m.type === "NOT_REGEXP"
          ? "!~"
          : "=";
  return `${m.name}${op}${m.value}`;
}

function mapCollection(accountId: string, typeId: string, x: Collection | Bucket, labels?: string) {
  const { slug, name, common } = identity(x);
  return instance(
    accountId,
    typeId,
    slug,
    name,
    {
      name,
      description: x.description,
      teamSlug: x.team_slug,
      notificationPolicySlug: x.notification_policy_slug,
      labels,
      ...common,
    },
    { slug },
  );
}

/** One mapper per type, so each reads the object the document says that type is. */
const MAPPERS: {
  [T in ConfigTypeId]: (accountId: string, x: ConfigObjects[T], base: string) => ResourceInstance;
} = {
  monitor(accountId, x) {
    const { slug, name, common } = identity(x);
    const queryType = x.prometheus_query
      ? "PromQL"
      : x.graphite_query
        ? "Graphite"
        : x.logging_query
          ? "Logs"
          : "";
    const groupLabels = x.signal_grouping?.label_names ?? [];
    return instance(
      accountId,
      "monitor",
      slug,
      name,
      {
        name,
        description: x.description,
        query: x.prometheus_query ?? x.graphite_query ?? x.logging_query,
        queryType,
        intervalSecs: x.interval_secs,
        conditions: describeConditions(x.series_conditions),
        collectionSlug: x.collection?.slug ?? x.collection_slug,
        bucketSlug: x.bucket_slug,
        notificationPolicySlug: x.notification_policy_slug,
        labels: labelsText(x.labels),
        signalGrouping: x.signal_grouping?.signal_per_series
          ? "Per series"
          : groupLabels.length
            ? `By ${groupLabels.join(", ")}`
            : "One signal",
        scheduled: Boolean(x.schedule),
        ...common,
      },
      { slug },
    );
  },
  "notification-policy"(accountId, x) {
    const { slug, name, common } = identity(x);
    return instance(
      accountId,
      "notification-policy",
      slug,
      name,
      {
        name,
        warnRoute: routeTargets(x.routes?.defaults?.warn),
        criticalRoute: routeTargets(x.routes?.defaults?.critical),
        overrideCount: (x.routes?.overrides ?? []).length,
        teamSlug: x.team_slug,
        ...common,
      },
      { slug },
    );
  },
  notifier(accountId, x) {
    const { slug, name, common } = identity(x);
    const t = notifierType(x);
    return instance(
      accountId,
      "notifier",
      slug,
      name,
      { name, skipResolved: x.skip_resolved === true, ...t, ...common },
      { slug },
    );
  },
  collection: (accountId, x) => mapCollection(accountId, "collection", x),
  bucket: (accountId, x) => mapCollection(accountId, "bucket", x, labelsText(x.labels)),
  team(accountId, x) {
    const { slug, name, common } = identity(x);
    return instance(
      accountId,
      "team",
      slug,
      name,
      {
        name,
        description: x.description,
        userEmails: (x.user_emails ?? []).join(", "),
        memberCount: (x.user_emails ?? []).length,
        ...common,
      },
      { slug },
    );
  },
  dashboard(accountId, x, base) {
    const { slug, name, common } = identity(x);
    return instance(
      accountId,
      "dashboard",
      slug,
      name,
      {
        name,
        collectionSlug: x.collection?.slug ?? x.collection_slug,
        labels: labelsText(x.labels),
        ...common,
      },
      { url: `${base}/dashboards/${slug}` },
    );
  },
  slo(accountId, x) {
    const { slug, name, common } = identity(x);
    const sli: Schemas["configv1SLI"] = x.sli ?? {};
    const indicator = sli.custom_timeslice_indicator
      ? `Timeslice: ${sli.custom_timeslice_indicator.query_template ?? ""}`
      : sli.custom_indicator
        ? `Good/bad: ${sli.custom_indicator.good_query_template ?? sli.custom_indicator.bad_query_template ?? ""}`
        : (sli.slo_type ?? "");
    return instance(
      accountId,
      "slo",
      slug,
      name,
      {
        name,
        description: x.description,
        objective: x.definition?.objective,
        timeWindow: x.definition?.time_window?.duration,
        indicator: String(indicator).slice(0, 500),
        burnRateAlerting: x.definition?.enable_burn_rate_alerting === true,
        collectionSlug: x.collection_ref?.slug,
        notificationPolicySlug: x.notification_policy_slug,
        ...common,
      },
      { slug },
    );
  },
  "rollup-rule"(accountId, x) {
    const { slug, name, common } = identity(x);
    return instance(accountId, "rollup-rule", slug, name, {
      name,
      mode: x.mode ?? "ENABLED",
      metricName: x.metric_name,
      aggregation: x.aggregation,
      filters: filtersText(x.filters),
      dropRaw: x.drop_raw === true,
      bucketSlug: x.bucket_slug,
      ...common,
    });
  },
  "drop-rule"(accountId, x) {
    const { slug, name, common } = identity(x);
    return instance(accountId, "drop-rule", slug, name, {
      name,
      mode: x.mode ?? "ENABLED",
      filters: filtersText(x.filters),
      conditional: Boolean(x.conditional_rate_based_drop?.enabled),
      dropNaN: x.drop_nan_value === true,
      ...common,
    });
  },
  "recording-rule"(accountId, x) {
    const { slug, name, common } = identity(x);
    return instance(accountId, "recording-rule", slug, name, {
      name,
      metricName: x.metric_name,
      expr: x.prometheus_expr,
      intervalSecs: x.interval_secs,
      executionGroup: x.execution_group,
      bucketSlug: x.bucket_slug,
      ...common,
    });
  },
  "muting-rule"(accountId, x) {
    const { slug, name } = identity(x);
    return instance(accountId, "muting-rule", slug, name, {
      name,
      matchers: (x.label_matchers ?? []).map(matcherText).join(", "),
      startsAt: x.starts_at,
      endsAt: x.ends_at,
      comment: x.comment,
      slug,
    });
  },
  "service-account"(accountId, x) {
    const { slug, name } = identity(x);
    return instance(accountId, "service-account", slug, name, {
      name,
      email: x.email,
      unrestricted: x.unrestricted === true,
      restriction: x.metrics_restriction
        ? JSON.stringify(x.metrics_restriction).slice(0, 300)
        : undefined,
      createdAt: x.created_at,
      slug,
    });
  },
  service(accountId, x) {
    const { slug, name } = identity(x);
    return instance(accountId, "service", slug, name, {
      name,
      description: x.description,
      teamSlug: x.team_slug,
      notificationPolicySlug: x.notification_policy_slug,
      slug,
    });
  },
};

export function mapConfig<T extends ConfigTypeId>(
  accountId: string,
  typeId: T,
  x: ConfigObjects[T],
  base: string,
): ResourceInstance {
  return MAPPERS[typeId](accountId, x, base);
}

type MatcherType = Schemas["configv1MutingRuleLabelMatcherMatcherType"];

function matcherType(op: string | undefined): MatcherType {
  if (op === "!=") return "NOT_EXACT";
  if (op === "=~") return "REGEX";
  if (op === "!~") return "NOT_REGEXP";
  return "EXACT";
}

/** `env=prod, service!=api, pod=~web-.*` → muting rule label matchers. */
export function parseMatchers(
  raw: string,
): Array<{ name: string; value: string; type: MatcherType }> {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const m = /^([A-Za-z_][A-Za-z0-9_.]*)\s*(=~|!~|!=|=)\s*(.*)$/.exec(part);
      if (!m)
        throw new Error(
          `Matcher "${part}" must look like label=value, label!=value, label=~regex or label!~regex.`,
        );
      return { name: m[1] ?? "", value: (m[3] ?? "").trim(), type: matcherType(m[2]) };
    });
}
