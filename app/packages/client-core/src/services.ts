/**
 * Services: a logical grouping of resources across providers.
 *
 * "Checkout API" is fourteen resources across three accounts on three
 * providers, and until a service exists nothing in the product can say so. A
 * service names that set, says who owns it and how critical it is, and links
 * the reliability objects that already exist on their own (SLOs, runbooks, an
 * on-call schedule) so one page can answer "is checkout healthy, what does it
 * cost, who is on call and what changed?".
 *
 * Membership is **explicit members plus rules**. Explicit members are picked
 * resources; rules match by tag, virtual tag or name so a new resource tagged
 * `service=checkout` joins without anybody editing the service. A resource a
 * rule matches but which does not belong can be **excluded**, which is stored
 * and survives the next sync, rather than removed (a rule would put it back).
 *
 * This module is the shared pure half every surface uses: the wire contract
 * for `/api/org/:orgId/services`, the input limits the editors and the API
 * both enforce, the rule matcher the server evaluates membership with, and the
 * Bearer fetch helpers mobile and the CLI call.
 */
import type { CloudFetch } from "./fetch";
import type { PostureFinding } from "./posture";
import type { OwnerSummary } from "./ownership";
import type { ScorecardResult } from "./scorecards";
import { extractRecordTags } from "./tag-policy";

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/** Criticality, 1 being the most critical. Null on a service means "not tiered". */
export type ServiceTier = 1 | 2 | 3 | 4;

export const SERVICE_TIERS: readonly ServiceTier[] = [1, 2, 3, 4];

export const SERVICE_TIER_LABELS: Readonly<Record<ServiceTier, string>> = {
  1: "Tier 1",
  2: "Tier 2",
  3: "Tier 3",
  4: "Tier 4",
};

export const SERVICE_TIER_DESCRIPTIONS: Readonly<Record<ServiceTier, string>> = {
  1: "Critical: customer-facing, an outage is an incident",
  2: "Important: degraded experience when it is down",
  3: "Internal: tools and back-office systems",
  4: "Experimental: prototypes and sandboxes",
};

export function isServiceTier(value: unknown): value is ServiceTier {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

// ---------------------------------------------------------------------------
// Membership rules
// ---------------------------------------------------------------------------

/**
 * - `tag`: the resource carries a provider tag/label `key`, with `value` when
 *   set (any value when null). Keys are matched case-insensitively (providers
 *   disagree about case), values exactly: the runbook and tag-policy stance.
 * - `virtual_tag`: the org's virtual tag `key` resolves to `value` on the
 *   resource's cost rows over the last 30 days. Evaluated against billing
 *   data, so it only ever matches resources that have per-resource cost rows.
 * - `name`: the resource's display name matches `value` per `nameMatch`,
 *   case-insensitively.
 *
 * `pluginId` and `accountId` narrow any rule to one provider or account.
 */
export type ServiceRuleKind = "tag" | "virtual_tag" | "name";

export const SERVICE_RULE_KINDS: readonly ServiceRuleKind[] = ["tag", "virtual_tag", "name"];

export const SERVICE_RULE_KIND_LABELS: Readonly<Record<ServiceRuleKind, string>> = {
  tag: "Tag",
  virtual_tag: "Virtual tag",
  name: "Name",
};

export type ServiceNameMatch = "contains" | "prefix" | "suffix" | "exact";

export const SERVICE_NAME_MATCHES: readonly ServiceNameMatch[] = [
  "contains",
  "prefix",
  "suffix",
  "exact",
];

export const SERVICE_NAME_MATCH_LABELS: Readonly<Record<ServiceNameMatch, string>> = {
  contains: "contains",
  prefix: "starts with",
  suffix: "ends with",
  exact: "is exactly",
};

export interface ServiceMembershipRule {
  kind: ServiceRuleKind;
  /** `tag` / `virtual_tag`: the key. Null for `name`. */
  key: string | null;
  /** `tag`: exact value, null for any. `virtual_tag`: required. `name`: the pattern. */
  value: string | null;
  /** `name` only. */
  nameMatch: ServiceNameMatch | null;
  /** Narrow to one provider. */
  pluginId: string | null;
  /** Narrow to one account. */
  accountId: string | null;
}

export const SERVICE_LIMITS = {
  nameMaxLength: 120,
  slugMaxLength: 64,
  descriptionMaxLength: 1000,
  ownerTeamMaxLength: 120,
  maxOwners: 20,
  maxLinks: 20,
  linkLabelMaxLength: 80,
  linkUrlMaxLength: 2000,
  maxRules: 20,
  ruleValueMaxLength: 256,
  maxSlos: 50,
  maxRunbooks: 50,
  maxMembersPerRequest: 500,
} as const;

/** Lower-case, dash-separated, the form a CLI argument or a URL wants. */
export const SERVICE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Derive a slug from a name: "Checkout API" → "checkout-api". */
export function slugifyServiceName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SERVICE_LIMITS.slugMaxLength)
    .replace(/-+$/g, "");
}

/** The resource facts a rule reads. `fields` is the stored `fields_json`. */
export interface ServiceRuleTarget {
  pluginId: string;
  accountId: string;
  displayName: string;
  fields?: Record<string, unknown> | null | undefined;
}

/**
 * Whether a `tag` or `name` rule matches a resource. `virtual_tag` rules are
 * evaluated against billing data by the server and always return false here,
 * since a resource row carries no virtual tag.
 */
export function serviceRuleMatches(
  rule: ServiceMembershipRule,
  target: ServiceRuleTarget,
): boolean {
  if (rule.pluginId && rule.pluginId !== target.pluginId) return false;
  if (rule.accountId && rule.accountId !== target.accountId) return false;
  switch (rule.kind) {
    case "tag": {
      if (!rule.key) return false;
      const tags = extractRecordTags(target.fields ?? null);
      if (!tags) return false;
      const key = rule.key.toLowerCase();
      const found = Object.entries(tags).find(([k]) => k.toLowerCase() === key);
      if (!found) return false;
      return rule.value == null || rule.value === "" || found[1] === rule.value;
    }
    case "name": {
      if (!rule.value) return false;
      const name = target.displayName.toLowerCase();
      const pattern = rule.value.toLowerCase();
      switch (rule.nameMatch ?? "contains") {
        case "prefix":
          return name.startsWith(pattern);
        case "suffix":
          return name.endsWith(pattern);
        case "exact":
          return name === pattern;
        case "contains":
          return name.includes(pattern);
      }
      return false;
    }
    case "virtual_tag":
      return false;
  }
}

/** One-line description of a rule, for lists and the CLI. */
export function describeServiceRule(rule: ServiceMembershipRule): string {
  let base: string;
  switch (rule.kind) {
    case "tag":
      base =
        rule.value == null || rule.value === ""
          ? `tagged ${rule.key ?? "?"}`
          : `tagged ${rule.key ?? "?"}=${rule.value}`;
      break;
    case "virtual_tag":
      base = `virtual tag ${rule.key ?? "?"}=${rule.value ?? "?"}`;
      break;
    case "name":
      base = `name ${SERVICE_NAME_MATCH_LABELS[rule.nameMatch ?? "contains"]} "${rule.value ?? ""}"`;
      break;
  }
  const narrow = [rule.pluginId, rule.accountId ? `account ${rule.accountId}` : null].filter(
    Boolean,
  );
  return narrow.length > 0 ? `${base} (${narrow.join(", ")})` : base;
}

/** Fill a partial rule with nulls so the stored shape is uniform. */
export function normalizeServiceRule(rule: Partial<ServiceMembershipRule>): ServiceMembershipRule {
  const kind = SERVICE_RULE_KINDS.includes(rule.kind as ServiceRuleKind)
    ? (rule.kind as ServiceRuleKind)
    : "tag";
  const trim = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  return {
    kind,
    key: kind === "name" ? null : trim(rule.key),
    value: trim(rule.value),
    nameMatch:
      kind === "name"
        ? SERVICE_NAME_MATCHES.includes(rule.nameMatch as ServiceNameMatch)
          ? (rule.nameMatch as ServiceNameMatch)
          : "contains"
        : null,
    pluginId: trim(rule.pluginId),
    accountId: trim(rule.accountId),
  };
}

// ---------------------------------------------------------------------------
// Wire contract
// ---------------------------------------------------------------------------

export interface ServiceLink {
  label: string;
  url: string;
}

export interface ServiceInput {
  name: string;
  /** Derived from the name when omitted on create. */
  slug?: string | undefined;
  description: string | null;
  tier: ServiceTier | null;
  /** Free-text owning team: display-only, never routed. */
  ownerTeam: string | null;
  /** Routable owners: org members. */
  ownerUserIds: string[];
  links: ServiceLink[];
  onCallScheduleId: string | null;
  sloIds: string[];
  runbookIds: string[];
  rules: ServiceMembershipRule[];
  /** Monthly budget in `budgetCurrency`; null for none. Read by the cost scorecard check. */
  monthlyBudget: number | null;
  budgetCurrency: string | null;
}

export interface ServiceOwner {
  userId: string;
  name: string | null;
  email: string | null;
}

/** One scorecard's standing on a service, as the list carries it. */
export interface ServiceScoreBadge {
  scorecardId: string;
  scorecardName: string;
  score: number | null;
  level: string | null;
  levelName: string | null;
}

export interface Service extends Omit<ServiceInput, "slug"> {
  id: string;
  slug: string;
  owners: ServiceOwner[];
  onCallScheduleName: string | null;
  /** Resolved members (explicit plus rule-matched, minus exclusions). */
  memberCount: number;
  scores: ServiceScoreBadge[];
  createdAt: string;
  updatedAt: string;
}

export interface ServiceListResponse {
  services: Service[];
}

/** How a resource came to be in a service. */
export type ServiceMemberSource = "manual" | "rule";

export interface ServiceMember {
  resourceId: string;
  accountId: string;
  accountName: string | null;
  pluginId: string;
  resourceTypeId: string;
  resourceName: string;
  externalId: string | null;
  source: ServiceMemberSource;
  /** Index into the service's rules, for `rule` members. */
  ruleIndex: number | null;
  /** The resource's own ownership record, when one names somebody. */
  owner: OwnerSummary | null;
  /** The resource was deleted upstream; kept so a manual member is not silently lost. */
  missing: boolean;
}

export interface ServiceCostTotal {
  currency: string;
  amount: number;
}

export interface ServiceCostSummary {
  windowDays: number;
  /** False when the cost warehouse could not be read. Never render that as zero. */
  available: boolean;
  totals: ServiceCostTotal[];
  byProvider: Array<{ pluginId: string; currency: string; amount: number }>;
  /** Members with per-resource cost rows in the window. */
  costedMembers: number;
}

export interface ServiceSloStanding {
  id: string;
  name: string;
  status: "exhausted" | "fast_burn" | "slow_burn" | "ok" | "unknown";
  targetPercent: number;
  budgetRemaining: number | null;
}

export interface ServiceRunbookRef {
  id: string;
  name: string;
  enabled: boolean;
}

export interface ServiceOnCall {
  scheduleId: string;
  scheduleName: string;
  enabled: boolean;
  current: { userId: string; name: string | null; email: string | null; endsAt: string } | null;
  next: { userId: string; name: string | null; email: string | null } | null;
}

export interface ServiceBackupFinding {
  resourceId: string;
  resourceName: string;
  /** "unprotected" | "rpo-breach" | "retention-below-policy" | "drill-stale" | "drill-failed" | "drill-never" */
  kind: string;
  detail: string;
}

export interface ServiceOrphanFinding {
  resourceId: string;
  resourceName: string;
  reason: string;
}

export interface ServiceFindings {
  posture: {
    counts: { critical: number; high: number; medium: number; low: number };
    items: PostureFinding[];
  };
  orphans: ServiceOrphanFinding[];
  backups: ServiceBackupFinding[];
  /** Feeds that failed to load; the counts above exclude them. */
  unavailable: Array<"posture" | "orphans" | "backups">;
}

export interface ServiceChange {
  id: string;
  resourceId: string;
  resourceName: string;
  pluginId: string;
  changeKind: "created" | "updated" | "deleted";
  fields: string[];
  at: string;
}

export interface ServiceDetailResponse {
  service: Service;
  members: ServiceMember[];
  /** Rule-matched resources the service deliberately leaves out. */
  excluded: ServiceMember[];
}

export interface ServiceSummaryResponse {
  service: Service;
  memberCount: number;
  cost: ServiceCostSummary;
  slos: ServiceSloStanding[];
  runbooks: ServiceRunbookRef[];
  onCall: ServiceOnCall | null;
  findings: ServiceFindings;
  recentChanges: ServiceChange[];
  scorecards: ScorecardResult[];
  generatedAt: string;
}

/** What `GET /services/for-resources` answers: resource id → services it belongs to. */
export interface ServiceRef {
  id: string;
  name: string;
  slug: string;
  tier: ServiceTier | null;
}

export interface ServicesForResourcesResponse {
  services: Record<string, ServiceRef[]>;
}

export interface ServiceMembersRequest {
  resourceIds: string[];
}

export const SERVICE_DEFAULTS: ServiceInput = {
  name: "",
  description: null,
  tier: null,
  ownerTeam: null,
  ownerUserIds: [],
  links: [],
  onCallScheduleId: null,
  sloIds: [],
  runbookIds: [],
  rules: [],
  monthlyBudget: null,
  budgetCurrency: null,
};

// ---------------------------------------------------------------------------
// Validation (the editors and the API run this one function)
// ---------------------------------------------------------------------------

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function validateServiceRule(rule: ServiceMembershipRule, index: number): string | null {
  const n = index + 1;
  if (!SERVICE_RULE_KINDS.includes(rule.kind)) return `Rule ${n}: unknown kind.`;
  if (rule.kind !== "name" && !rule.key) return `Rule ${n}: choose a tag key.`;
  if (rule.kind === "virtual_tag" && !rule.value) return `Rule ${n}: choose a virtual tag value.`;
  if (rule.kind === "name" && !rule.value) return `Rule ${n}: enter the name to match.`;
  if ((rule.value ?? "").length > SERVICE_LIMITS.ruleValueMaxLength) {
    return `Rule ${n}: the value is too long.`;
  }
  if ((rule.key ?? "").length > SERVICE_LIMITS.ruleValueMaxLength) {
    return `Rule ${n}: the key is too long.`;
  }
  return null;
}

export function validateServiceInput(input: ServiceInput): string | null {
  const name = input.name.trim();
  if (!name) return "Give the service a name.";
  if (name.length > SERVICE_LIMITS.nameMaxLength) {
    return `Names are at most ${SERVICE_LIMITS.nameMaxLength} characters.`;
  }
  if (input.slug !== undefined) {
    if (
      !SERVICE_SLUG_PATTERN.test(input.slug) ||
      input.slug.length > SERVICE_LIMITS.slugMaxLength
    ) {
      return "The slug may contain lower-case letters, digits and dashes, and cannot start or end with a dash.";
    }
  }
  if ((input.description ?? "").length > SERVICE_LIMITS.descriptionMaxLength) {
    return `Descriptions are at most ${SERVICE_LIMITS.descriptionMaxLength} characters.`;
  }
  if (input.tier !== null && !isServiceTier(input.tier)) return "The tier must be 1, 2, 3 or 4.";
  if ((input.ownerTeam ?? "").length > SERVICE_LIMITS.ownerTeamMaxLength) {
    return `Team names are at most ${SERVICE_LIMITS.ownerTeamMaxLength} characters.`;
  }
  if (input.ownerUserIds.length > SERVICE_LIMITS.maxOwners) {
    return `A service can have at most ${SERVICE_LIMITS.maxOwners} owners.`;
  }
  if (input.links.length > SERVICE_LIMITS.maxLinks) {
    return `A service can have at most ${SERVICE_LIMITS.maxLinks} links.`;
  }
  for (const link of input.links) {
    if (!link.label.trim()) return "Every link needs a label.";
    if (link.label.length > SERVICE_LIMITS.linkLabelMaxLength) return "A link label is too long.";
    if (link.url.length > SERVICE_LIMITS.linkUrlMaxLength || !isHttpUrl(link.url)) {
      return `"${link.label}" is not an http or https URL.`;
    }
  }
  if (input.sloIds.length > SERVICE_LIMITS.maxSlos) {
    return `A service can link at most ${SERVICE_LIMITS.maxSlos} SLOs.`;
  }
  if (input.runbookIds.length > SERVICE_LIMITS.maxRunbooks) {
    return `A service can link at most ${SERVICE_LIMITS.maxRunbooks} runbooks.`;
  }
  if (input.rules.length > SERVICE_LIMITS.maxRules) {
    return `A service can have at most ${SERVICE_LIMITS.maxRules} membership rules.`;
  }
  for (const [index, rule] of input.rules.entries()) {
    const problem = validateServiceRule(rule, index);
    if (problem) return problem;
  }
  if (input.monthlyBudget !== null) {
    if (!Number.isFinite(input.monthlyBudget) || input.monthlyBudget < 0) {
      return "The monthly budget must be zero or more.";
    }
    if (!input.budgetCurrency || !/^[A-Z]{3}$/.test(input.budgetCurrency)) {
      return "Choose the budget's currency.";
    }
  }
  return null;
}

/** Sum costs per currency, never across currencies. */
export function formatServiceCost(totals: readonly ServiceCostTotal[]): string {
  if (totals.length === 0) return "0";
  return totals
    .map((t) => {
      try {
        return new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: t.currency,
          maximumFractionDigits: 0,
        }).format(t.amount);
      } catch {
        return `${t.amount.toFixed(0)} ${t.currency}`;
      }
    })
    .join(" + ");
}

// ---------------------------------------------------------------------------
// Bearer fetch helpers (mobile, the CLI, any host that talks the cloud API)
// ---------------------------------------------------------------------------

/** `GET /api/org/:orgId/services` (`resources:read`). */
export async function fetchServices(api: CloudFetch, orgId: string): Promise<ServiceListResponse> {
  const res = await api.org<ServiceListResponse>(orgId, "/services");
  return res ?? { services: [] };
}

/** `GET /api/org/:orgId/services/:id`: the service with its resolved members. */
export async function fetchServiceDetail(
  api: CloudFetch,
  orgId: string,
  serviceId: string,
): Promise<ServiceDetailResponse | null> {
  return api.org<ServiceDetailResponse>(orgId, `/services/${encodeURIComponent(serviceId)}`);
}

/** `GET /api/org/:orgId/services/:id/summary`: cost, SLOs, findings, on-call, changes. */
export async function fetchServiceSummary(
  api: CloudFetch,
  orgId: string,
  serviceId: string,
): Promise<ServiceSummaryResponse | null> {
  return api.org<ServiceSummaryResponse>(
    orgId,
    `/services/${encodeURIComponent(serviceId)}/summary`,
  );
}

export async function createService(
  api: CloudFetch,
  orgId: string,
  body: Partial<ServiceInput> & { name: string },
): Promise<Service | null> {
  return api.org<Service>(orgId, "/services", { method: "POST", body: JSON.stringify(body) });
}

export async function updateService(
  api: CloudFetch,
  orgId: string,
  serviceId: string,
  body: Partial<ServiceInput>,
): Promise<Service | null> {
  return api.org<Service>(orgId, `/services/${encodeURIComponent(serviceId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function deleteService(
  api: CloudFetch,
  orgId: string,
  serviceId: string,
): Promise<void> {
  await api.org(orgId, `/services/${encodeURIComponent(serviceId)}`, { method: "DELETE" });
}

export async function addServiceMembers(
  api: CloudFetch,
  orgId: string,
  serviceId: string,
  resourceIds: string[],
): Promise<ServiceDetailResponse | null> {
  return api.org<ServiceDetailResponse>(
    orgId,
    `/services/${encodeURIComponent(serviceId)}/members`,
    { method: "POST", body: JSON.stringify({ resourceIds } satisfies ServiceMembersRequest) },
  );
}

export async function removeServiceMember(
  api: CloudFetch,
  orgId: string,
  serviceId: string,
  resourceId: string,
): Promise<ServiceDetailResponse | null> {
  return api.org<ServiceDetailResponse>(
    orgId,
    `/services/${encodeURIComponent(serviceId)}/members/${encodeURIComponent(resourceId)}`,
    { method: "DELETE" },
  );
}

/** `GET /api/org/:orgId/services/for-resources?ids=a,b`: which services own these resources. */
export async function fetchServicesForResources(
  api: CloudFetch,
  orgId: string,
  resourceIds: string[],
): Promise<ServicesForResourcesResponse> {
  if (resourceIds.length === 0) return { services: {} };
  const ids = resourceIds.map(encodeURIComponent).join(",");
  const res = await api.org<ServicesForResourcesResponse>(
    orgId,
    `/services/for-resources?ids=${ids}`,
  );
  return res ?? { services: {} };
}
