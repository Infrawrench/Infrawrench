/**
 * Savings findings workflow: one list over every savings finder, with a
 * lifecycle per finding and saved views over it.
 *
 * The finders themselves (orphans, Oversized right-sizing, extended support
 * surcharges, unused SaaS seats) stay recomputed on read, exactly as before.
 * What this adds is the memory around them, kept server-side in
 * `savings_finding_states` (the table the savings scan already used to tell
 * "new" from "seen"):
 *
 * - a **status** per finding: Ready for review, In progress, Completed,
 *   Archived; who moved it there, when, and an optional note;
 * - the **detected date**, the first time anything observed the finding;
 * - **automatic completion**: when a scan that computed a finder successfully
 *   no longer reports one of its findings (the resource was deleted, resized,
 *   or is in use again), an open finding (Ready or In progress) moves to
 *   Completed with `resolution: "resolved"`. Archived findings stay archived
 *   and manually completed ones keep their manual resolution. A finding that
 *   comes back after being resolved automatically reopens as Ready with a new
 *   detected date, because it is a new occurrence;
 * - **saved views**: a named filter + status tab + sort, shareable like cost
 *   reports and canvases (`savings_view` in the per-object sharing model).
 *
 * Server contract: `GET /api/org/:orgId/savings/findings` (`resources:read`,
 * the finders' own permission), `POST /savings/findings/status`
 * (`resources:write`, the dismissal argument: archiving silences a finding
 * for everyone), `/savings-views` CRUD (`resources:read` / `resources:write`,
 * narrowed by sharing).
 *
 * Pure apart from the fetch helpers at the bottom (used by mobile and the CLI).
 */
import type { CloudFetch } from "./fetch";

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

/** The finders a finding can come from. */
export const SAVINGS_FINDING_KINDS = ["orphan", "oversized", "extended_support", "seat"] as const;
export type SavingsFindingKind = (typeof SAVINGS_FINDING_KINDS)[number];

export function isSavingsFindingKind(value: unknown): value is SavingsFindingKind {
  return (SAVINGS_FINDING_KINDS as readonly unknown[]).includes(value);
}

export const SAVINGS_FINDING_KIND_LABELS: Record<SavingsFindingKind, string> = {
  orphan: "Orphaned or idle",
  oversized: "Oversized",
  extended_support: "Extended support",
  seat: "Unused seat",
};

/** Lifecycle, in workflow order. */
export const SAVINGS_FINDING_STATUSES = ["ready", "in_progress", "completed", "archived"] as const;
export type SavingsFindingStatus = (typeof SAVINGS_FINDING_STATUSES)[number];

export function isSavingsFindingStatus(value: unknown): value is SavingsFindingStatus {
  return (SAVINGS_FINDING_STATUSES as readonly unknown[]).includes(value);
}

export const SAVINGS_FINDING_STATUS_LABELS: Record<SavingsFindingStatus, string> = {
  ready: "Ready for review",
  in_progress: "In progress",
  completed: "Completed",
  archived: "Archived",
};

/** Statuses whose money still counts as potential savings. */
export const OPEN_SAVINGS_FINDING_STATUSES: readonly SavingsFindingStatus[] = [
  "ready",
  "in_progress",
];

export function isOpenSavingsFindingStatus(status: SavingsFindingStatus): boolean {
  return status === "ready" || status === "in_progress";
}

/** A status tab: one status, every open one, or everything. */
export const SAVINGS_FINDING_STATUS_FILTERS = ["open", ...SAVINGS_FINDING_STATUSES, "all"] as const;
export type SavingsFindingStatusFilter = (typeof SAVINGS_FINDING_STATUS_FILTERS)[number];

export function isSavingsFindingStatusFilter(value: unknown): value is SavingsFindingStatusFilter {
  return (SAVINGS_FINDING_STATUS_FILTERS as readonly unknown[]).includes(value);
}

/**
 * How a completed finding got there: a person said so (`manual`), or a scan
 * stopped reporting it (`resolved`).
 */
export type SavingsFindingResolution = "manual" | "resolved";

/** The finding key: `<kind>:<source id>`. Stable across scans. */
export function savingsFindingKey(kind: SavingsFindingKind, sourceId: string): string {
  return `${kind}:${sourceId}`;
}

/** Split a key back into kind and source id; null when it is not one. */
export function parseSavingsFindingKey(
  key: string,
): { kind: SavingsFindingKind; sourceId: string } | null {
  const at = key.indexOf(":");
  if (at <= 0) return null;
  const kind = key.slice(0, at);
  const sourceId = key.slice(at + 1);
  if (!isSavingsFindingKind(kind) || sourceId === "") return null;
  return { kind, sourceId };
}

/* ------------------------------------------------------------------ *
 * Wire shapes
 * ------------------------------------------------------------------ */

export interface SavingsFindingMoney {
  amount: number;
  /** ISO 4217. */
  currency: string;
}

export interface SavingsFindingActor {
  userId: string;
  /** Display name or email; null when the member has left. */
  name: string | null;
}

export interface SavingsFinding {
  /** `<kind>:<sourceId>`; the handle for status changes. */
  key: string;
  kind: SavingsFindingKind;
  /** The finder's own id: a resource id, or a seat finding's id. */
  sourceId: string;
  /** One line, e.g. "Right-size web-1 from 4 vCPU to 2 vCPU". */
  title: string;
  /** The finder's reason, when it gave one. */
  detail: string | null;
  pluginId: string | null;
  pluginName: string | null;
  accountId: string | null;
  accountName: string | null;
  region: string | null;
  /** Infrawrench resource id, for opening the resource; null for seats. */
  resourceId: string | null;
  /** Resource (or seat holder) display name. */
  resourceName: string;
  /** For opening the resource; null for seats. */
  resourceTypeId: string | null;
  resourceTypeName: string | null;
  /** Tags on the resource when last seen; empty when it has none. */
  tags: Record<string, string>;
  /** What acting on it saves per month; null when the finder has no price. */
  monthlySavings: SavingsFindingMoney | null;
  status: SavingsFindingStatus;
  /** When the status last changed; null while it is still the initial Ready. */
  statusChangedAt: string | null;
  /** Who changed it; null for the initial Ready and for automatic changes. */
  statusChangedBy: SavingsFindingActor | null;
  statusNote: string | null;
  /** Set for Completed findings. */
  resolution: SavingsFindingResolution | null;
  /** First time any scan or read observed this finding (this occurrence). */
  detectedAt: string;
  /** Last time a scan or read observed it. */
  lastSeenAt: string;
  /** False once a scan stopped reporting it. */
  present: boolean;
  /** The realized-savings entry recorded for the fix, when there is one. */
  realizedSavings: { eventId: string; title: string } | null;
}

export interface SavingsFindingsSummary {
  /** Findings per status, over every finding the caller can see. */
  counts: Record<SavingsFindingStatus, number>;
  /** Monthly savings of open findings (Ready + In progress), per currency, largest first. */
  potentialMonthly: SavingsFindingMoney[];
  /** Open findings with no price: counted, never summed as zero. */
  unpricedOpenCount: number;
  /**
   * Realized savings over the trailing `realizedWindowDays` (the realized
   * savings report's own figures), per currency. Null when the caller cannot
   * read cost data.
   */
  realized: SavingsFindingMoney[] | null;
  realizedWindowDays: number;
  /**
   * Realized ÷ (realized + potential), per currency: the share of the
   * identified monthly opportunity already captured. Both sides are monthly
   * run-rates (30 days of realized savings against monthly potential). Only
   * currencies with a non-zero denominator appear; null with `realized`.
   */
  savingsRate: { currency: string; rate: number }[] | null;
}

export interface SavingsFindingsResponse {
  /** Matching findings, already filtered and sorted when the request asked. */
  findings: SavingsFinding[];
  /** Over every finding the caller can see, ignoring the request's filters. */
  summary: SavingsFindingsSummary;
  /** Finders that failed to compute this time: their open findings are missing, not fixed. */
  unavailable: { kind: SavingsFindingKind; error: string }[];
  generatedAt: string;
}

/* ------------------------------------------------------------------ *
 * Filters and sorting (shared by the API, the UI and the CLI)
 * ------------------------------------------------------------------ */

export interface SavingsFindingTagFilter {
  key: string;
  /** Any of these values; empty or absent means "has the key at all". */
  values?: string[] | undefined;
}

export interface SavingsFindingFilter {
  kinds?: SavingsFindingKind[] | undefined;
  pluginIds?: string[] | undefined;
  accountIds?: string[] | undefined;
  regions?: string[] | undefined;
  /** Every tag term must match (AND). */
  tags?: SavingsFindingTagFilter[] | undefined;
  /**
   * Minimum monthly savings, compared in each finding's own currency (there is
   * no conversion here). Unpriced findings never pass a minimum.
   */
  minMonthlySavings?: number | null | undefined;
  /** Detected on or after this day, `YYYY-MM-DD` (UTC). */
  detectedFrom?: string | null | undefined;
  /** Detected on or before this day, `YYYY-MM-DD` (UTC). */
  detectedTo?: string | null | undefined;
  /** Case-insensitive substring over title, resource and account names. */
  search?: string | null | undefined;
}

export const SAVINGS_FINDING_SORT_FIELDS = [
  "savings",
  "detected",
  "name",
  "status_changed",
] as const;
export type SavingsFindingSortField = (typeof SAVINGS_FINDING_SORT_FIELDS)[number];

export interface SavingsFindingSort {
  field: SavingsFindingSortField;
  direction: "asc" | "desc";
}

export const DEFAULT_SAVINGS_FINDING_SORT: SavingsFindingSort = {
  field: "savings",
  direction: "desc",
};

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** Whether a finding passes the status tab. */
export function matchesSavingsFindingStatus(
  finding: Pick<SavingsFinding, "status">,
  status: SavingsFindingStatusFilter,
): boolean {
  if (status === "all") return true;
  if (status === "open") return isOpenSavingsFindingStatus(finding.status);
  return finding.status === status;
}

/** Whether a finding passes the filter (status is separate). */
export function matchesSavingsFindingFilter(
  finding: SavingsFinding,
  filter: SavingsFindingFilter,
): boolean {
  if (filter.kinds?.length && !filter.kinds.includes(finding.kind)) return false;
  if (filter.pluginIds?.length && !filter.pluginIds.includes(finding.pluginId ?? "")) return false;
  if (filter.accountIds?.length && !filter.accountIds.includes(finding.accountId ?? "")) {
    return false;
  }
  if (filter.regions?.length && !filter.regions.includes(finding.region ?? "")) return false;
  for (const tag of filter.tags ?? []) {
    const key = Object.keys(finding.tags).find((k) => k.toLowerCase() === tag.key.toLowerCase());
    if (key === undefined) return false;
    if (tag.values?.length && !tag.values.includes(finding.tags[key]!)) return false;
  }
  const min = filter.minMonthlySavings;
  if (min !== undefined && min !== null && min > 0) {
    if (!finding.monthlySavings || finding.monthlySavings.amount < min) return false;
  }
  const detected = dayOf(finding.detectedAt);
  if (filter.detectedFrom && detected < filter.detectedFrom) return false;
  if (filter.detectedTo && detected > filter.detectedTo) return false;
  const q = filter.search?.trim().toLowerCase();
  if (q) {
    const hay = [
      finding.title,
      finding.resourceName,
      finding.accountName ?? "",
      finding.detail ?? "",
    ]
      .join("\n")
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** Whether a filter narrows anything at all. */
export function isEmptySavingsFindingFilter(filter: SavingsFindingFilter): boolean {
  return (
    !filter.kinds?.length &&
    !filter.pluginIds?.length &&
    !filter.accountIds?.length &&
    !filter.regions?.length &&
    !filter.tags?.length &&
    !(filter.minMonthlySavings && filter.minMonthlySavings > 0) &&
    !filter.detectedFrom &&
    !filter.detectedTo &&
    !filter.search?.trim()
  );
}

/**
 * Sort a copy. Unpriced findings sort after priced ones whichever way savings
 * run (an unknown is not "the smallest"), ties break on name then key so the
 * order is stable across reloads.
 */
export function sortSavingsFindings(
  findings: readonly SavingsFinding[],
  sort: SavingsFindingSort = DEFAULT_SAVINGS_FINDING_SORT,
): SavingsFinding[] {
  const dir = sort.direction === "asc" ? 1 : -1;
  const byName = (a: SavingsFinding, b: SavingsFinding) =>
    a.resourceName.localeCompare(b.resourceName) || a.key.localeCompare(b.key);
  return [...findings].sort((a, b) => {
    switch (sort.field) {
      case "savings": {
        const av = a.monthlySavings?.amount;
        const bv = b.monthlySavings?.amount;
        if (av === undefined && bv === undefined) return byName(a, b);
        if (av === undefined) return 1;
        if (bv === undefined) return -1;
        return (av - bv) * dir || byName(a, b);
      }
      case "detected":
        return a.detectedAt.localeCompare(b.detectedAt) * dir || byName(a, b);
      case "status_changed": {
        const av = a.statusChangedAt ?? "";
        const bv = b.statusChangedAt ?? "";
        if (av === bv) return byName(a, b);
        if (av === "") return 1;
        if (bv === "") return -1;
        return av.localeCompare(bv) * dir;
      }
      case "name":
        return byName(a, b) * dir;
    }
  });
}

/** Filter, status tab and sort in one call: what a view applies. */
export function applySavingsFindingView(
  findings: readonly SavingsFinding[],
  view: {
    status: SavingsFindingStatusFilter;
    filter: SavingsFindingFilter;
    sort: SavingsFindingSort;
  },
): SavingsFinding[] {
  return sortSavingsFindings(
    findings.filter(
      (f) =>
        matchesSavingsFindingStatus(f, view.status) && matchesSavingsFindingFilter(f, view.filter),
    ),
    view.sort,
  );
}

function sumByCurrency(items: SavingsFindingMoney[]): SavingsFindingMoney[] {
  const totals = new Map<string, number>();
  for (const m of items) totals.set(m.currency, (totals.get(m.currency) ?? 0) + m.amount);
  return [...totals.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency));
}

/** Counts per status. */
export function countSavingsFindingsByStatus(
  findings: readonly Pick<SavingsFinding, "status">[],
): Record<SavingsFindingStatus, number> {
  const counts: Record<SavingsFindingStatus, number> = {
    ready: 0,
    in_progress: 0,
    completed: 0,
    archived: 0,
  };
  for (const f of findings) counts[f.status] += 1;
  return counts;
}

/**
 * The savings rate, per currency: realized ÷ (realized + potential). A
 * currency with nothing on either side is omitted rather than reported as 0%
 * or 100%. Negative realized (a resource grew back) is clamped to zero for
 * the rate: a rate below zero reads as nonsense, and the realized tile still
 * shows the negative figure.
 */
export function savingsRate(
  realized: readonly SavingsFindingMoney[],
  potential: readonly SavingsFindingMoney[],
): { currency: string; rate: number }[] {
  const currencies = new Set([...realized, ...potential].map((m) => m.currency));
  const out: { currency: string; rate: number }[] = [];
  for (const currency of currencies) {
    const r = Math.max(0, realized.find((m) => m.currency === currency)?.amount ?? 0);
    const p = Math.max(0, potential.find((m) => m.currency === currency)?.amount ?? 0);
    if (r + p <= 0) continue;
    out.push({ currency, rate: r / (r + p) });
  }
  // Largest opportunity first, so the headline currency leads.
  const weight = (c: string) =>
    (realized.find((m) => m.currency === c)?.amount ?? 0) +
    (potential.find((m) => m.currency === c)?.amount ?? 0);
  return out.sort((a, b) => weight(b.currency) - weight(a.currency));
}

/** The summary tiles over a set of findings. */
export function summarizeSavingsFindings(
  findings: readonly SavingsFinding[],
  realized: SavingsFindingMoney[] | null,
  realizedWindowDays: number,
): SavingsFindingsSummary {
  const open = findings.filter((f) => isOpenSavingsFindingStatus(f.status));
  const potentialMonthly = sumByCurrency(
    open.flatMap((f) => (f.monthlySavings ? [f.monthlySavings] : [])),
  );
  return {
    counts: countSavingsFindingsByStatus(findings),
    potentialMonthly,
    unpricedOpenCount: open.filter((f) => !f.monthlySavings).length,
    realized,
    realizedWindowDays,
    savingsRate: realized ? savingsRate(realized, potentialMonthly) : null,
  };
}

/* ------------------------------------------------------------------ *
 * Status changes
 * ------------------------------------------------------------------ */

export const SAVINGS_FINDING_LIMITS = {
  /** Findings one bulk status change may touch. */
  maxBulkKeys: 500,
  maxNoteLength: 1000,
} as const;

/** `POST /savings/findings/status`. */
export interface SavingsFindingStatusInput {
  keys: string[];
  status: SavingsFindingStatus;
  /** Recorded on every finding changed; null or absent clears the previous note. */
  note?: string | null | undefined;
}

export interface SavingsFindingStatusChange {
  key: string;
  status: SavingsFindingStatus;
  statusChangedAt: string;
  statusChangedBy: SavingsFindingActor | null;
  statusNote: string | null;
  resolution: SavingsFindingResolution | null;
}

export interface SavingsFindingStatusResult {
  updated: SavingsFindingStatusChange[];
  /** Keys with no finding on record (never observed, or not visible to the caller). */
  missing: string[];
}

/**
 * Validate a status change body. Keys are de-duplicated; each must parse.
 * @throws {Error} with a caller-presentable message.
 */
export function normalizeSavingsFindingStatusInput(raw: unknown): SavingsFindingStatusInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Expected a JSON object.");
  }
  const body = raw as Record<string, unknown>;
  const keys = body["keys"];
  if (!Array.isArray(keys) || keys.length === 0) throw new Error("keys must be a non-empty list.");
  if (keys.length > SAVINGS_FINDING_LIMITS.maxBulkKeys) {
    throw new Error(`At most ${SAVINGS_FINDING_LIMITS.maxBulkKeys} findings per change.`);
  }
  const unique: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string" || !parseSavingsFindingKey(key)) {
      throw new Error(`Not a finding key: ${String(key)}`);
    }
    if (!unique.includes(key)) unique.push(key);
  }
  const status = body["status"];
  if (!isSavingsFindingStatus(status)) {
    throw new Error("status must be ready, in_progress, completed or archived.");
  }
  const note = body["note"];
  if (note !== undefined && note !== null && typeof note !== "string") {
    throw new Error("note must be a string.");
  }
  const trimmed = typeof note === "string" ? note.trim() : "";
  if (trimmed.length > SAVINGS_FINDING_LIMITS.maxNoteLength) {
    throw new Error(`note must be at most ${SAVINGS_FINDING_LIMITS.maxNoteLength} characters.`);
  }
  return { keys: unique, status, note: trimmed === "" ? null : trimmed };
}

/* ------------------------------------------------------------------ *
 * Saved views
 * ------------------------------------------------------------------ */

export const SAVINGS_VIEW_LIMITS = {
  maxNameLength: 120,
  maxDescriptionLength: 2000,
  /** Values per list filter (accounts, regions...). */
  maxFilterValues: 200,
  maxTagTerms: 20,
  maxSearchLength: 200,
} as const;

/** Create/update body for `/savings-views` (full replace on update). */
export interface SavingsViewInput {
  name: string;
  description?: string | null | undefined;
  status: SavingsFindingStatusFilter;
  filter: SavingsFindingFilter;
  sort: SavingsFindingSort;
}

export interface SavingsView {
  id: string;
  name: string;
  description: string | null;
  status: SavingsFindingStatusFilter;
  filter: SavingsFindingFilter;
  sort: SavingsFindingSort;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`filter.${field} must be a list.`);
  if (value.length > SAVINGS_VIEW_LIMITS.maxFilterValues) {
    throw new Error(`filter.${field} takes at most ${SAVINGS_VIEW_LIMITS.maxFilterValues} values.`);
  }
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`filter.${field} must hold non-empty strings.`);
    }
    if (!out.includes(v.trim())) out.push(v.trim());
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Validate and canonicalize a filter: empty lists and blank fields are
 * dropped, so two spellings of "no filter" store identically (and Terraform
 * sees no diff between them).
 * @throws {Error} with a caller-presentable message.
 */
export function normalizeSavingsFindingFilter(raw: unknown): SavingsFindingFilter {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("filter must be an object.");
  const body = raw as Record<string, unknown>;
  const known = new Set([
    "kinds",
    "pluginIds",
    "accountIds",
    "regions",
    "tags",
    "minMonthlySavings",
    "detectedFrom",
    "detectedTo",
    "search",
  ]);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) throw new Error(`Unknown filter field: ${key}`);
  }
  const out: SavingsFindingFilter = {};
  const kinds = stringList(body["kinds"], "kinds");
  if (kinds) {
    for (const k of kinds) {
      if (!isSavingsFindingKind(k)) throw new Error(`Unknown finding kind: ${k}`);
    }
    out.kinds = kinds as SavingsFindingKind[];
  }
  const pluginIds = stringList(body["pluginIds"], "pluginIds");
  if (pluginIds) out.pluginIds = pluginIds;
  const accountIds = stringList(body["accountIds"], "accountIds");
  if (accountIds) out.accountIds = accountIds;
  const regions = stringList(body["regions"], "regions");
  if (regions) out.regions = regions;

  const tags = body["tags"];
  if (tags !== undefined && tags !== null) {
    if (!Array.isArray(tags)) throw new Error("filter.tags must be a list.");
    if (tags.length > SAVINGS_VIEW_LIMITS.maxTagTerms) {
      throw new Error(`filter.tags takes at most ${SAVINGS_VIEW_LIMITS.maxTagTerms} terms.`);
    }
    const terms: SavingsFindingTagFilter[] = [];
    for (const t of tags) {
      if (!t || typeof t !== "object") throw new Error("Each tag term must be an object.");
      const term = t as Record<string, unknown>;
      const key = term["key"];
      if (typeof key !== "string" || key.trim() === "") {
        throw new Error("Each tag term needs a key.");
      }
      const values = stringList(term["values"], "tags.values");
      terms.push(values ? { key: key.trim(), values } : { key: key.trim() });
    }
    if (terms.length > 0) out.tags = terms;
  }

  const min = body["minMonthlySavings"];
  if (min !== undefined && min !== null) {
    if (typeof min !== "number" || !Number.isFinite(min) || min < 0) {
      throw new Error("filter.minMonthlySavings must be a number of zero or more.");
    }
    if (min > 0) out.minMonthlySavings = min;
  }
  for (const field of ["detectedFrom", "detectedTo"] as const) {
    const v = body[field];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || !ISO_DAY.test(v)) {
      throw new Error(`filter.${field} must be a YYYY-MM-DD date.`);
    }
    out[field] = v;
  }
  if (out.detectedFrom && out.detectedTo && out.detectedFrom > out.detectedTo) {
    throw new Error("filter.detectedFrom must not be after detectedTo.");
  }
  const search = body["search"];
  if (search !== undefined && search !== null) {
    if (typeof search !== "string") throw new Error("filter.search must be a string.");
    if (search.length > SAVINGS_VIEW_LIMITS.maxSearchLength) {
      throw new Error(
        `filter.search must be at most ${SAVINGS_VIEW_LIMITS.maxSearchLength} characters.`,
      );
    }
    if (search.trim() !== "") out.search = search.trim();
  }
  return out;
}

/** @throws {Error} with a caller-presentable message. */
export function normalizeSavingsFindingSort(raw: unknown): SavingsFindingSort {
  if (raw === undefined || raw === null) return { ...DEFAULT_SAVINGS_FINDING_SORT };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("sort must be an object.");
  const body = raw as Record<string, unknown>;
  const field = body["field"];
  if (!(SAVINGS_FINDING_SORT_FIELDS as readonly unknown[]).includes(field)) {
    throw new Error("sort.field must be savings, detected, name or status_changed.");
  }
  const direction = body["direction"];
  if (direction !== "asc" && direction !== "desc") {
    throw new Error("sort.direction must be asc or desc.");
  }
  return { field: field as SavingsFindingSortField, direction };
}

/**
 * Validate a saved view body.
 * @throws {Error} with a caller-presentable message.
 */
export function normalizeSavingsViewInput(raw: unknown): SavingsViewInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Expected a JSON object.");
  }
  const body = raw as Record<string, unknown>;
  const name = body["name"];
  if (typeof name !== "string" || name.trim() === "") throw new Error("name is required.");
  if (name.trim().length > SAVINGS_VIEW_LIMITS.maxNameLength) {
    throw new Error(`name must be at most ${SAVINGS_VIEW_LIMITS.maxNameLength} characters.`);
  }
  const description = body["description"];
  if (description !== undefined && description !== null && typeof description !== "string") {
    throw new Error("description must be a string.");
  }
  if (
    typeof description === "string" &&
    description.trim().length > SAVINGS_VIEW_LIMITS.maxDescriptionLength
  ) {
    throw new Error(
      `description must be at most ${SAVINGS_VIEW_LIMITS.maxDescriptionLength} characters.`,
    );
  }
  const status = body["status"] ?? "open";
  if (!isSavingsFindingStatusFilter(status)) {
    throw new Error("status must be open, ready, in_progress, completed, archived or all.");
  }
  return {
    name: name.trim(),
    description:
      typeof description === "string" && description.trim() !== "" ? description.trim() : null,
    status,
    filter: normalizeSavingsFindingFilter(body["filter"]),
    sort: normalizeSavingsFindingSort(body["sort"]),
  };
}

/* ------------------------------------------------------------------ *
 * Query strings (the API's GET filters, the CLI, deep links)
 * ------------------------------------------------------------------ */

/**
 * Encode a filter, status and sort as `GET /savings/findings` query params.
 * Lists are comma-joined; tag terms are `key` or `key=value`, repeated.
 */
export function savingsFindingsQuery(opts: {
  status?: SavingsFindingStatusFilter | undefined;
  filter?: SavingsFindingFilter | undefined;
  sort?: SavingsFindingSort | undefined;
  viewId?: string | undefined;
}): URLSearchParams {
  const q = new URLSearchParams();
  if (opts.viewId) q.set("view", opts.viewId);
  if (opts.status) q.set("status", opts.status);
  const f = opts.filter ?? {};
  if (f.kinds?.length) q.set("kind", f.kinds.join(","));
  if (f.pluginIds?.length) q.set("provider", f.pluginIds.join(","));
  if (f.accountIds?.length) q.set("account", f.accountIds.join(","));
  if (f.regions?.length) q.set("region", f.regions.join(","));
  for (const t of f.tags ?? []) {
    if (!t.values?.length) q.append("tag", t.key);
    else for (const v of t.values) q.append("tag", `${t.key}=${v}`);
  }
  if (f.minMonthlySavings) q.set("minSavings", String(f.minMonthlySavings));
  if (f.detectedFrom) q.set("detectedFrom", f.detectedFrom);
  if (f.detectedTo) q.set("detectedTo", f.detectedTo);
  if (f.search) q.set("q", f.search);
  if (opts.sort) q.set("sort", `${opts.sort.field}:${opts.sort.direction}`);
  return q;
}

/**
 * Decode `GET /savings/findings` query params. Absent params leave the field
 * out. Repeated `tag=k=v` terms for one key merge into one term.
 * @throws {Error} with a caller-presentable message.
 */
export function parseSavingsFindingsQuery(
  get: (name: string) => string | undefined,
  getAll: (name: string) => string[],
): {
  status?: SavingsFindingStatusFilter;
  filter: SavingsFindingFilter;
  sort?: SavingsFindingSort;
  viewId?: string;
} {
  const list = (name: string) =>
    (get(name) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const tagTerms = new Map<string, string[]>();
  for (const raw of getAll("tag")) {
    const eq = raw.indexOf("=");
    const key = (eq < 0 ? raw : raw.slice(0, eq)).trim();
    if (!key) continue;
    const values = tagTerms.get(key) ?? [];
    if (eq >= 0 && raw.slice(eq + 1).trim()) values.push(raw.slice(eq + 1).trim());
    tagTerms.set(key, values);
  }
  const minRaw = get("minSavings");
  const filter = normalizeSavingsFindingFilter({
    kinds: list("kind"),
    pluginIds: list("provider"),
    accountIds: list("account"),
    regions: list("region"),
    tags: [...tagTerms.entries()].map(([key, values]) =>
      values.length ? { key, values } : { key },
    ),
    minMonthlySavings: minRaw === undefined || minRaw === "" ? undefined : Number(minRaw),
    detectedFrom: get("detectedFrom"),
    detectedTo: get("detectedTo"),
    search: get("q"),
  });
  const out: ReturnType<typeof parseSavingsFindingsQuery> = { filter };
  const status = get("status");
  if (status !== undefined && status !== "") {
    if (!isSavingsFindingStatusFilter(status)) {
      throw new Error("status must be open, ready, in_progress, completed, archived or all.");
    }
    out.status = status;
  }
  const sort = get("sort");
  if (sort) {
    const [field, direction = "desc"] = sort.split(":");
    out.sort = normalizeSavingsFindingSort({ field, direction });
  }
  const view = get("view");
  if (view) out.viewId = view;
  return out;
}

/* ------------------------------------------------------------------ *
 * Fetch helpers (mobile, CLI)
 * ------------------------------------------------------------------ */

const EMPTY_SUMMARY: SavingsFindingsSummary = {
  counts: { ready: 0, in_progress: 0, completed: 0, archived: 0 },
  potentialMonthly: [],
  unpricedOpenCount: 0,
  realized: null,
  realizedWindowDays: 30,
  savingsRate: null,
};

/** `GET /savings/findings` (`resources:read`). */
export async function fetchSavingsFindings(
  api: CloudFetch,
  orgId: string,
  opts: Parameters<typeof savingsFindingsQuery>[0] = {},
): Promise<SavingsFindingsResponse> {
  const qs = savingsFindingsQuery(opts).toString();
  const res = await api.org<SavingsFindingsResponse>(
    orgId,
    `/savings/findings${qs ? `?${qs}` : ""}`,
  );
  return (
    res ?? {
      findings: [],
      summary: EMPTY_SUMMARY,
      unavailable: [],
      generatedAt: new Date().toISOString(),
    }
  );
}

/** `GET /savings-views`: the views the caller can see, alphabetically. */
export async function fetchSavingsViews(api: CloudFetch, orgId: string): Promise<SavingsView[]> {
  return (await api.org<SavingsView[]>(orgId, "/savings-views")) ?? [];
}
