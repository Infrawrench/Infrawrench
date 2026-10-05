/**
 * Extended support findings: resources running a version their provider has
 * moved out of standard support, and what that costs.
 *
 * Plugins declare each provider's support calendar on the resource type
 * (`extendedSupport`, `ExtendedSupportDeclaration` in
 * `@infrawrench/plugin-base`) and this module is the shared pure half that
 * turns stored rows + those declarations into findings: which version, when
 * the surcharge started (or starts), what it costs per month at list price,
 * when the provider upgrades it anyway, and what to upgrade to. Every surface
 * reads it: the Costs panel section on web/desktop/mobile, the
 * `infrawrench extended-support` CLI, the `list_extended_support` MCP tool,
 * the poller's `extendedSupportAlerts` pass, and the expiry radar (which gets
 * the upcoming deadlines as `kind: "extended-support"` items from
 * {@link extendedSupportExpiryItems}).
 *
 * Rows in, findings out: no plugin client, no credentials, no provider API
 * calls; the `orphanRule`/`postureChecks` contract. The cloud host can then
 * overlay what the provider actually billed ({@link applyExtendedSupportBilling})
 * where a plugin implements `fetchExtendedSupportCharges`; that overlay is
 * also pure, so the attribution rules are tested here rather than in a route.
 *
 * The plugin-base import is type-only on purpose (the expiry radar's stance):
 * the mobile bundle must not pull in zod for a few interfaces.
 */
import type {
  ExtendedSupportCharge,
  ExtendedSupportCondition,
  ExtendedSupportDeclaration,
  ExtendedSupportRelease,
  ExtendedSupportUnit,
} from "@infrawrench/plugin-base";

import type { ExpiryItem, ExpirySeverity } from "./expiry";
import type { CloudFetch } from "./fetch";

export type {
  ExtendedSupportCharge,
  ExtendedSupportCondition,
  ExtendedSupportDeclaration,
  ExtendedSupportRateTier,
  ExtendedSupportRelease,
  ExtendedSupportSurcharge,
  ExtendedSupportUnit,
} from "@infrawrench/plugin-base";

/** Hours an hourly rate is multiplied by to state a monthly figure. */
export const EXTENDED_SUPPORT_HOURS_PER_MONTH = 730;

/** Default look-ahead for upcoming surcharges when the org has no settings row. */
export const DEFAULT_EXTENDED_SUPPORT_LEAD_DAYS = 90;

/** Bounds the API enforces on the org's settings; shared by form, server and Terraform docs. */
export const EXTENDED_SUPPORT_LIMITS = {
  leadDays: { min: 1, max: 365 },
} as const;

/**
 * Where a finding stands on its provider's calendar:
 *
 * - `surcharged`: past standard support and paying for extended support now.
 * - `unsupported`: past standard support with no surcharge, because the
 *   provider offers no paid extension or this resource is not enrolled in
 *   one; a forced upgrade is pending.
 * - `end-of-life`: past the end of extended support too; the provider can
 *   upgrade it at any time.
 * - `upcoming`: still in standard support, but it ends within the lead time.
 */
export type ExtendedSupportStatus = "surcharged" | "unsupported" | "end-of-life" | "upcoming";

/** Statuses in display order, most urgent first. */
export const EXTENDED_SUPPORT_STATUSES: readonly ExtendedSupportStatus[] = [
  "end-of-life",
  "surcharged",
  "unsupported",
  "upcoming",
];

/** Human labels for the status buckets, shared by every surface. */
export const EXTENDED_SUPPORT_STATUS_LABELS: Record<ExtendedSupportStatus, string> = {
  "end-of-life": "Past end of support",
  surcharged: "Paying extended support",
  unsupported: "Out of standard support",
  upcoming: "Surcharge upcoming",
};

/** Human labels for surcharge units. */
export const EXTENDED_SUPPORT_UNIT_LABELS: Record<ExtendedSupportUnit, string> = {
  "cluster-hour": "cluster-hour",
  "vcpu-hour": "vCPU-hour",
  "vcore-hour": "vCore-hour",
  "node-hour": "node-hour",
  "instance-hour": "instance-hour",
  "acu-hour": "ACU-hour",
};

/**
 * Where a finding's monthly figure came from:
 *
 * - `billed`: the provider's own billing, attributable to this resource alone.
 * - `billed-share`: the provider billed this line for several matching
 *   resources and the figure is this one's share, weighted by list price.
 * - `list-price`: computed from the plugin's published rates.
 * - `unpriced`: no figure: no surcharge applies, the tier is priced relative
 *   to something we cannot see, or the resource's size is unknown.
 */
export type ExtendedSupportCostBasis = "billed" | "billed-share" | "list-price" | "unpriced";

/** One resource on one calendar entry. A resource matches at most one entry. */
export interface ExtendedSupportFinding {
  /** Infrawrench resource id. */
  resourceId: string;
  pluginId: string;
  pluginName: string;
  resourceTypeId: string;
  resourceTypeName: string;
  accountId: string;
  accountName: string;
  displayName: string;
  externalId: string | null;
  region: string | null;
  /** The matched calendar entry's stable id, unique within the type. */
  releaseId: string;
  /** Product caption, e.g. "Amazon EKS". */
  product: string;
  engine: string | null;
  currentVersion: string;
  targetVersion: string;
  status: ExtendedSupportStatus;
  /** Last day of standard support, `YYYY-MM-DD`. */
  standardSupportEnds: string;
  /** First day the surcharge applies (the day after standard support ends). */
  surchargeStartsOn: string;
  /** Whole days until `surchargeStartsOn`; zero or negative once it started. */
  daysUntilSurcharge: number;
  /** Last day of extended support, when the provider published one. */
  extendedSupportEnds: string | null;
  /** Whole days until the provider upgrades it; negative once overdue. */
  daysUntilForcedUpgrade: number | null;
  /**
   * Whether the surcharge applies to this resource at all: false when the
   * entry has no paid extension or the resource is not enrolled in one.
   */
  charged: boolean;
  /** Billable units (vCPUs, nodes; 1 for a per-resource charge); null when unknown. */
  quantity: number | null;
  unit: ExtendedSupportUnit | null;
  currency: string | null;
  /** The tier in force now (or the first tier, for an upcoming finding). */
  tierLabel: string | null;
  /**
   * The monthly surcharge an upgrade removes: what is being paid now, or for
   * an `upcoming` finding what will be paid once it starts. Null means no
   * figure (see `costBasis`), never zero.
   */
  monthlySurcharge: number | null;
  /** The list-price figure, kept beside a billed one so the two can be compared. */
  listMonthlySurcharge: number | null;
  costBasis: ExtendedSupportCostBasis;
  /** Provider line items the billed figure came from. Empty unless billed. */
  billedLineItems: string[];
  /** The next, higher tier, when the rate is scheduled to rise. */
  nextTier: { from: string; label: string; monthlySurcharge: number | null } | null;
  /** Caveat on the list-price figure (region, rounding). */
  priceNote: string | null;
  pricingUrl: string | null;
  upgradeUrl: string;
  /** Plugin-authored caveat, or why the resource is not charged. */
  note: string | null;
}

/** A billed line no synced resource could be matched to. */
export interface UnattributedExtendedSupportCharge extends ExtendedSupportCharge {
  accountId: string;
  accountName: string;
  /** The line's monthly run rate over the billing window. */
  monthlyAmount: number;
}

/** How the cloud host's billing overlay went, per account. */
export interface ExtendedSupportBillingStatus {
  /** Trailing days of billing read. */
  windowDays: number;
  accounts: Array<{
    accountId: string;
    accountName: string;
    status: "read" | "failed";
    error?: string;
  }>;
  unattributed: UnattributedExtendedSupportCharge[];
}

/** Monthly totals per currency; providers bill in their own. */
export interface ExtendedSupportTotal {
  currency: string;
  monthly: number;
}

/** Wire shape of `GET /api/org/:orgId/extended-support` and the local assembly. */
export interface ExtendedSupportListResponse {
  /** Most urgent first, then largest monthly surcharge. */
  findings: ExtendedSupportFinding[];
  totalCount: number;
  /** Findings per status; every bucket present. */
  counts: Record<ExtendedSupportStatus, number>;
  /** What the org pays per month now (surcharged + end-of-life findings with a figure). */
  currentMonthly: ExtendedSupportTotal[];
  /** What upcoming findings will add per month once their surcharges start. */
  upcomingMonthly: ExtendedSupportTotal[];
  /** The look-ahead the `upcoming` bucket was computed against. */
  leadDays: number;
  /** Present when the host tried to read billed charges; absent in local mode. */
  billing?: ExtendedSupportBillingStatus;
  generatedAt: string;
}

/** The part of a resource type definition the scan reads. */
export interface ExtendedSupportScanResourceType {
  id: string;
  displayName: string;
  extendedSupport?: ExtendedSupportDeclaration | undefined;
}

export interface ExtendedSupportScanPlugin {
  id: string;
  displayName: string;
  resourceTypes: readonly ExtendedSupportScanResourceType[];
}

export interface ExtendedSupportScanAccount {
  id: string;
  displayName: string;
  pluginId: string;
}

export interface ExtendedSupportScanResource {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId: string | null;
  fields: unknown;
}

export interface ExtendedSupportScanInput {
  plugins: readonly ExtendedSupportScanPlugin[];
  accounts: readonly ExtendedSupportScanAccount[];
  resources: readonly ExtendedSupportScanResource[];
}

export interface ExtendedSupportScanOptions {
  /** Scan instant; defaults to `Date.now()`. */
  now?: number;
  /** Look-ahead for `upcoming`; defaults to {@link DEFAULT_EXTENDED_SUPPORT_LEAD_DAYS}. */
  leadDays?: number;
}

const MS_PER_DAY = 86_400_000;

const STATUS_RANK: Record<ExtendedSupportStatus, number> = {
  "end-of-life": 0,
  surcharged: 1,
  unsupported: 2,
  upcoming: 3,
};

/** Epoch ms of a `YYYY-MM-DD` day's UTC midnight; NaN when malformed. */
function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function addDays(day: string, days: number): string {
  return new Date(dayStart(day) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

function daysUntil(ms: number, now: number): number {
  return Math.floor((ms - now) / MS_PER_DAY);
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Whether a stored version falls under a declared prefix: case-insensitive,
 * at a boundary, ignoring a leading `v`. See `ExtendedSupportRelease.versions`.
 */
export function extendedSupportVersionMatches(stored: string, prefix: string): boolean {
  const s = stored
    .trim()
    .toLowerCase()
    .replace(/^v(?=\d)/, "");
  const p = prefix
    .trim()
    .toLowerCase()
    .replace(/^v(?=\d)/, "");
  if (p === "" || !s.startsWith(p)) return false;
  const next = s.charAt(p.length);
  return next === "" || !/[0-9a-z]/.test(next);
}

/** The calendar entry a resource's fields match, if any. First match wins. */
export function matchExtendedSupportRelease(
  decl: ExtendedSupportDeclaration,
  fields: Record<string, unknown>,
): ExtendedSupportRelease | null {
  const version = asString(fields[decl.versionFieldKey]);
  if (!version) return null;
  const engine = decl.engineFieldKey ? asString(fields[decl.engineFieldKey]) : null;
  for (const release of decl.releases) {
    if (release.engines) {
      if (!engine) continue;
      const e = engine.toLowerCase();
      if (!release.engines.some((x) => x.toLowerCase() === e)) continue;
    }
    if (release.versions.some((p) => extendedSupportVersionMatches(version, p))) return release;
  }
  return null;
}

function conditionHolds(cond: ExtendedSupportCondition, fields: Record<string, unknown>): boolean {
  const raw = asString(fields[cond.fieldKey]);
  if (cond.in) return raw !== null && cond.in.some((v) => v.toLowerCase() === raw.toLowerCase());
  if (cond.notIn)
    return raw === null || !cond.notIn.some((v) => v.toLowerCase() === raw.toLowerCase());
  return true;
}

function readQuantity(decl: ExtendedSupportDeclaration, fields: Record<string, unknown>) {
  if (!decl.quantityFieldKey) return 1;
  const raw = fields[decl.quantityFieldKey];
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function fieldsOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface IndexedType {
  pluginName: string;
  typeName: string;
  decl: ExtendedSupportDeclaration;
}

function indexDeclarations(plugins: readonly ExtendedSupportScanPlugin[]) {
  const index = new Map<string, IndexedType>();
  for (const plugin of plugins) {
    for (const type of plugin.resourceTypes) {
      if (type.extendedSupport && type.extendedSupport.releases.length > 0)
        index.set(`${plugin.id}\u0000${type.id}`, {
          pluginName: plugin.displayName,
          typeName: type.displayName,
          decl: type.extendedSupport,
        });
    }
  }
  return index;
}

function emptyCounts(): Record<ExtendedSupportStatus, number> {
  return { "end-of-life": 0, surcharged: 0, unsupported: 0, upcoming: 0 };
}

function totalsBy(findings: ExtendedSupportFinding[]): ExtendedSupportTotal[] {
  const sums = new Map<string, number>();
  for (const f of findings) {
    if (f.monthlySurcharge === null || f.currency === null) continue;
    sums.set(f.currency, (sums.get(f.currency) ?? 0) + f.monthlySurcharge);
  }
  return [...sums.entries()]
    .map(([currency, monthly]) => ({ currency, monthly: roundCents(monthly) }))
    .sort((a, b) => b.monthly - a.monthly || a.currency.localeCompare(b.currency));
}

function compareFindings(a: ExtendedSupportFinding, b: ExtendedSupportFinding): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    (b.monthlySurcharge ?? -1) - (a.monthlySurcharge ?? -1) ||
    a.daysUntilSurcharge - b.daysUntilSurcharge ||
    a.displayName.localeCompare(b.displayName) ||
    a.resourceId.localeCompare(b.resourceId)
  );
}

/**
 * Rebuild counts, totals and order after findings changed (the billing
 * overlay, or a cost-visibility scope narrowing them to visible accounts).
 */
export function summarizeExtendedSupport(
  findings: ExtendedSupportFinding[],
  rest: Omit<
    ExtendedSupportListResponse,
    "findings" | "totalCount" | "counts" | "currentMonthly" | "upcomingMonthly"
  >,
): ExtendedSupportListResponse {
  const sorted = [...findings].sort(compareFindings);
  const counts = emptyCounts();
  for (const f of sorted) counts[f.status] += 1;
  return {
    findings: sorted,
    totalCount: sorted.length,
    counts,
    currentMonthly: totalsBy(
      sorted.filter((f) => f.status === "surcharged" || f.status === "end-of-life"),
    ),
    upcomingMonthly: totalsBy(sorted.filter((f) => f.status === "upcoming")),
    ...rest,
  };
}

/**
 * Compute the extended-support findings for a workspace.
 *
 * Pure and deterministic. Resources whose account is missing are skipped (a
 * soft-deleted account is not a finding), as is any resource whose version
 * matches no calendar entry, and any entry whose standard support ends
 * further out than the lead time.
 */
export function computeExtendedSupport(
  input: ExtendedSupportScanInput,
  options: ExtendedSupportScanOptions = {},
): ExtendedSupportListResponse {
  const now = options.now ?? Date.now();
  const leadDays = options.leadDays ?? DEFAULT_EXTENDED_SUPPORT_LEAD_DAYS;
  const index = indexDeclarations(input.plugins);
  const accountMap = new Map(input.accounts.map((a) => [a.id, a]));
  const findings: ExtendedSupportFinding[] = [];

  if (index.size > 0) {
    for (const r of input.resources) {
      const entry = index.get(`${r.pluginId}\u0000${r.resourceTypeId}`);
      if (!entry) continue;
      const account = accountMap.get(r.accountId);
      if (!account) continue;
      const fields = fieldsOf(r.fields);
      if (!fields) continue;
      const finding = evaluate(entry, r, account.displayName, fields, now, leadDays);
      if (finding) findings.push(finding);
    }
  }

  return summarizeExtendedSupport(findings, { leadDays, generatedAt: new Date(now).toISOString() });
}

function evaluate(
  entry: IndexedType,
  r: ExtendedSupportScanResource,
  accountName: string,
  fields: Record<string, unknown>,
  now: number,
  leadDays: number,
): ExtendedSupportFinding | null {
  const { decl } = entry;
  const release = matchExtendedSupportRelease(decl, fields);
  if (!release) return null;
  const surchargeStartsOn = addDays(release.standardSupportEnds, 1);
  const startMs = dayStart(surchargeStartsOn);
  if (Number.isNaN(startMs)) return null;
  const daysUntilSurcharge = daysUntil(startMs, now);
  const endMs = release.extendedSupportEnds
    ? dayStart(addDays(release.extendedSupportEnds, 1))
    : null;

  let status: ExtendedSupportStatus;
  const chargedByPolicy = (decl.chargedWhen ?? []).every((c) => conditionHolds(c, fields));
  const charged = release.surcharge !== undefined && chargedByPolicy;
  if (now < startMs) {
    if (daysUntilSurcharge > leadDays) return null;
    status = "upcoming";
  } else if (endMs !== null && now >= endMs) {
    status = "end-of-life";
  } else {
    status = charged ? "surcharged" : "unsupported";
  }

  const surcharge = charged ? release.surcharge! : null;
  const quantity = surcharge ? readQuantity(decl, fields) : null;
  const today = new Date(Math.max(now, startMs)).toISOString().slice(0, 10);
  const tiers = surcharge?.tiers ?? [];
  let tierIndex = -1;
  tiers.forEach((t, i) => {
    if (t.from <= today) tierIndex = i;
  });
  // An upcoming finding is priced at the tier it will start on. A started
  // one whose first tier is still in the future (a provider's billing grace
  // period) has no rate in force yet: it shows the first tier as "next".
  if (surcharge && tierIndex === -1 && status === "upcoming") tierIndex = 0;
  const tier = tierIndex >= 0 ? tiers[tierIndex]! : null;
  const monthlyFor = (rate: number | undefined): number | null =>
    rate !== undefined && quantity !== null
      ? roundCents(rate * quantity * EXTENDED_SUPPORT_HOURS_PER_MONTH)
      : null;
  const monthly = tier ? monthlyFor(tier.rate) : null;
  const next = tiers[tierIndex + 1];

  const region = decl.regionFieldKey ? asString(fields[decl.regionFieldKey]) : null;
  const engine = decl.engineFieldKey ? asString(fields[decl.engineFieldKey]) : null;
  const notes = [release.note, !chargedByPolicy ? decl.notChargedNote : undefined].filter(
    (n): n is string => typeof n === "string" && n !== "",
  );

  return {
    resourceId: r.id,
    pluginId: r.pluginId,
    pluginName: entry.pluginName,
    resourceTypeId: r.resourceTypeId,
    resourceTypeName: entry.typeName,
    accountId: r.accountId,
    accountName,
    displayName: r.displayName,
    externalId: r.externalId,
    region,
    releaseId: release.id,
    product: release.product,
    engine,
    currentVersion: asString(fields[decl.versionFieldKey]) ?? "",
    targetVersion: release.targetVersion,
    status,
    standardSupportEnds: release.standardSupportEnds,
    surchargeStartsOn,
    daysUntilSurcharge,
    extendedSupportEnds: release.extendedSupportEnds ?? null,
    daysUntilForcedUpgrade: endMs !== null ? daysUntil(endMs, now) : null,
    charged,
    quantity,
    unit: surcharge?.unit ?? null,
    currency: surcharge?.currency ?? null,
    tierLabel: tier?.label ?? null,
    monthlySurcharge: monthly,
    listMonthlySurcharge: monthly,
    costBasis: monthly !== null ? "list-price" : "unpriced",
    billedLineItems: [],
    nextTier: next
      ? { from: next.from, label: next.label, monthlySurcharge: monthlyFor(next.rate) }
      : null,
    priceNote: surcharge?.priceNote ?? null,
    pricingUrl: release.surcharge?.pricingUrl ?? null,
    upgradeUrl: release.upgradeUrl,
    note: notes.length > 0 ? notes.join(" ") : null,
  };
}

/** One account's billed charges, as the cloud host read them. */
export interface ExtendedSupportAccountBilling {
  accountId: string;
  accountName: string;
  /** Null when the read failed; `error` then says why. */
  charges: ExtendedSupportCharge[] | null;
  error?: string;
}

/**
 * Overlay billed charges onto computed findings.
 *
 * Billing data rarely names the resource, so each charge is matched to the
 * account's billable findings (`surcharged` / `end-of-life`, `charged`) of
 * the same resource type, narrowed by region and engine when the charge
 * names them. One candidate: the figure is `billed`. Several: the charge is
 * split by list-price weight (equally when any candidate has no list price)
 * and each share is `billed-share`. None: the line is reported as
 * unattributed rather than dropped, because money nobody can explain is the
 * finding most worth seeing.
 *
 * A billable finding in an account whose billing was read but carried no
 * matching line keeps its list price: billing lags usage by a day or more,
 * and a surcharge that has not been invoiced yet has not stopped.
 */
export function applyExtendedSupportBilling(
  feed: ExtendedSupportListResponse,
  billing: readonly ExtendedSupportAccountBilling[],
  windowDays: number,
): ExtendedSupportListResponse {
  const findings = feed.findings.map((f) => ({ ...f, billedLineItems: [...f.billedLineItems] }));
  const billedAmounts = new Map<ExtendedSupportFinding, number>();
  const basis = new Map<ExtendedSupportFinding, ExtendedSupportCostBasis>();
  const unattributed: UnattributedExtendedSupportCharge[] = [];
  const perMonth = EXTENDED_SUPPORT_HOURS_PER_MONTH / 24 / Math.max(1, windowDays);

  for (const account of billing) {
    if (!account.charges) continue;
    for (const charge of account.charges) {
      if (!(charge.amount > 0)) continue;
      const candidates = findings.filter(
        (f) =>
          f.accountId === account.accountId &&
          charge.resourceTypeId !== undefined &&
          f.resourceTypeId === charge.resourceTypeId &&
          (!charge.releaseId || f.releaseId === charge.releaseId) &&
          f.charged &&
          (f.status === "surcharged" || f.status === "end-of-life") &&
          (!charge.region || (f.region ?? "").toLowerCase() === charge.region.toLowerCase()) &&
          (!charge.engine || (f.engine ?? "").toLowerCase() === charge.engine.toLowerCase()),
      );
      const monthlyAmount = charge.amount * perMonth;
      if (candidates.length === 0) {
        unattributed.push({
          ...charge,
          accountId: account.accountId,
          accountName: account.accountName,
          monthlyAmount: roundCents(monthlyAmount),
        });
        continue;
      }
      const weights = candidates.every((c) => (c.listMonthlySurcharge ?? 0) > 0)
        ? candidates.map((c) => c.listMonthlySurcharge!)
        : candidates.map(() => 1);
      const total = weights.reduce((a, b) => a + b, 0);
      candidates.forEach((c, i) => {
        billedAmounts.set(c, (billedAmounts.get(c) ?? 0) + (monthlyAmount * weights[i]!) / total);
        if (!c.billedLineItems.includes(charge.lineItem)) c.billedLineItems.push(charge.lineItem);
        // Shared once is shared: a later sole-candidate line must not upgrade it.
        basis.set(
          c,
          candidates.length === 1 && basis.get(c) !== "billed-share" ? "billed" : "billed-share",
        );
        if (c.currency === null) c.currency = charge.currency;
      });
    }
  }

  for (const [finding, amount] of billedAmounts) {
    finding.monthlySurcharge = roundCents(amount);
    finding.costBasis = basis.get(finding) ?? "billed";
  }

  return summarizeExtendedSupport(findings, {
    leadDays: feed.leadDays,
    generatedAt: feed.generatedAt,
    billing: {
      windowDays,
      accounts: billing.map((a) => ({
        accountId: a.accountId,
        accountName: a.accountName,
        status: a.charges ? ("read" as const) : ("failed" as const),
        ...(a.error ? { error: a.error } : {}),
      })),
      unattributed: unattributed.sort((a, b) => b.monthlyAmount - a.monthlyAmount),
    },
  });
}

/**
 * The deadlines the expiry radar shows for extended support: each matching
 * resource's next date, whatever the lead time (the radar applies its own
 * `upcoming` window and shows `ok` items too).
 *
 * - Still in standard support: the day the surcharge (or, with no paid
 *   extension, the forced upgrade) starts.
 * - In extended support with a published end: the forced-upgrade date.
 * - Past that end: an `expired` item, which is the one state worth an alarm.
 *
 * A resource already paying with no published end date yields no item: it
 * has no clock left, only a cost, and the findings list is where that lives.
 */
export function extendedSupportExpiryItems(
  input: ExtendedSupportScanInput,
  options: { now: number; severity: (daysRemaining: number) => ExpirySeverity },
): ExpiryItem[] {
  const index = indexDeclarations(input.plugins);
  if (index.size === 0) return [];
  const accountMap = new Map(input.accounts.map((a) => [a.id, a]));
  const items: ExpiryItem[] = [];
  for (const r of input.resources) {
    const entry = index.get(`${r.pluginId}\u0000${r.resourceTypeId}`);
    if (!entry) continue;
    const account = accountMap.get(r.accountId);
    const fields = fieldsOf(r.fields);
    if (!account || !fields) continue;
    const release = matchExtendedSupportRelease(entry.decl, fields);
    if (!release) continue;
    const startMs = dayStart(addDays(release.standardSupportEnds, 1));
    if (Number.isNaN(startMs)) continue;
    const endMs = release.extendedSupportEnds
      ? dayStart(addDays(release.extendedSupportEnds, 1))
      : null;
    const charged =
      release.surcharge !== undefined &&
      (entry.decl.chargedWhen ?? []).every((c) => conditionHolds(c, fields));
    const version = asString(fields[entry.decl.versionFieldKey]) ?? "";
    let dueMs: number;
    let label: string;
    if (options.now < startMs) {
      dueMs = startMs;
      label = charged
        ? `${release.product} ${version}: extended support surcharge starts`
        : `${release.product} ${version}: standard support ends`;
    } else if (endMs !== null) {
      dueMs = endMs;
      label = `${release.product} ${version}: extended support ends (forced upgrade)`;
    } else {
      continue;
    }
    const daysRemaining = daysUntil(dueMs, options.now);
    items.push({
      resourceId: r.id,
      pluginId: r.pluginId,
      pluginName: entry.pluginName,
      resourceTypeId: r.resourceTypeId,
      resourceTypeName: entry.typeName,
      accountId: r.accountId,
      accountName: account.displayName,
      displayName: r.displayName,
      externalId: r.externalId,
      fieldKey: entry.decl.versionFieldKey,
      kind: "extended-support",
      label,
      basis: "expiry",
      dueAt: new Date(dueMs).toISOString(),
      daysRemaining,
      severity: options.severity(daysRemaining),
    });
  }
  return items;
}

/** The findings the poller alerts on: money being spent, or a lapsed deadline. */
export function alertableExtendedSupport(
  feed: ExtendedSupportListResponse,
): ExtendedSupportFinding[] {
  return feed.findings.filter((f) => f.status === "surcharged" || f.status === "end-of-life");
}

/**
 * The identity of a finding: the resource and the calendar entry. Used for
 * row keys. NUL-joined for the reason `postureFindingKey` is; issue filing
 * uses {@link extendedSupportIssueSourceId} instead.
 */
export function extendedSupportFindingKey(f: { resourceId: string; releaseId: string }): string {
  return `${f.resourceId}\u0000${f.releaseId}`;
}

/**
 * The source id a filed Jira/Linear issue is linked under, so a finding is
 * filed once. Not the NUL-joined row key: Postgres `text` cannot hold NUL.
 * Keyed on the calendar entry too, so a cluster that is later upgraded onto
 * another old version is a new finding with its own issue.
 */
export function extendedSupportIssueSourceId(f: { resourceId: string; releaseId: string }): string {
  return `${f.resourceId}#${f.releaseId}`;
}

/** Format a monthly amount for text surfaces (CLI, alerts, issue bodies). */
export function formatExtendedSupportMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: amount >= 100 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * Org settings: the wire shape of `GET|PUT /api/org/:orgId/extended-support/settings`
 * (permission `org:settings:write` to write).
 */
export interface ExtendedSupportSettings {
  /** Whether the poller sends extended-support alerts for this org. */
  enabled: boolean;
  /** Days ahead an upcoming surcharge is listed (and counted) for. */
  leadDays: number;
  /** When the org's last alert scan ran; null before the first. */
  lastNotifiedAt: string | null;
}

export interface ExtendedSupportSettingsPatch {
  enabled?: boolean;
  leadDays?: number;
}

const DEFAULT_SETTINGS: ExtendedSupportSettings = {
  enabled: true,
  leadDays: DEFAULT_EXTENDED_SUPPORT_LEAD_DAYS,
  lastNotifiedAt: null,
};

export async function getExtendedSupportSettings(
  api: CloudFetch,
  orgId: string,
): Promise<ExtendedSupportSettings> {
  return (
    (await api.org<ExtendedSupportSettings>(orgId, "/extended-support/settings")) ??
    DEFAULT_SETTINGS
  );
}

export async function updateExtendedSupportSettings(
  api: CloudFetch,
  orgId: string,
  patch: ExtendedSupportSettingsPatch,
): Promise<ExtendedSupportSettings> {
  return (
    (await api.org<ExtendedSupportSettings>(orgId, "/extended-support/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    })) ?? DEFAULT_SETTINGS
  );
}

/** An empty response, for hosts that have nothing to scan. */
export function emptyExtendedSupportResponse(
  leadDays = DEFAULT_EXTENDED_SUPPORT_LEAD_DAYS,
): ExtendedSupportListResponse {
  return summarizeExtendedSupport([], { leadDays, generatedAt: new Date().toISOString() });
}

/**
 * Read `GET /api/org/:orgId/extended-support` (permission `resources:read`).
 * `refresh` bypasses the server's short billing cache.
 */
export async function fetchExtendedSupport(
  api: CloudFetch,
  orgId: string,
  opts: { refresh?: boolean } = {},
): Promise<ExtendedSupportListResponse> {
  const res = await api.org<ExtendedSupportListResponse>(
    orgId,
    `/extended-support${opts.refresh ? "?refresh=true" : ""}`,
  );
  return res ?? emptyExtendedSupportResponse();
}
