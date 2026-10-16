/**
 * Who bills what: the scope arithmetic behind bulk assignment and the
 * unassigned-spend finder.
 *
 * Both features read the same thing: the period's spend resolved to **buckets**
 * exactly the way an invoice resolves it. The org's allocation rules claim
 * spend for cost centres first; whatever no rule claimed falls to its cloud
 * account. A bucket is therefore a cost-centre id, `acct:<accountId>`, or the
 * empty string for spend that resolved to neither (a disconnected account, an
 * uploaded cost source with no account).
 *
 * Reading the buckets that way, rather than summing spend per account, is what
 * keeps the two features honest against the invoices themselves: an account
 * named on a customer claims only the spend no cost centre claimed, so
 * "this account's unassigned spend" has to mean the same slice, or assigning
 * it would move less money than the preview promised.
 *
 * Pure: the server does the one scan and hands the buckets in.
 */

export const ACCOUNT_SCOPE_BUCKET_PREFIX = "acct:";

/** One bucket's spend in one currency. */
export interface ScopeSpendBucket {
  /** Cost-centre id, `acct:<accountId>`, or `""` for spend that resolved to neither. */
  bucket: string;
  currency: string;
  amount: number;
}

export interface ScopeCentre {
  id: string;
  name: string;
  parentId: string | null;
}

export interface ScopeAccount {
  id: string;
  displayName: string;
  pluginId: string;
}

export interface ScopeOwner {
  id: string;
  name: string;
  costCentreIds: readonly string[];
  accountIds: readonly string[];
}

export type ScopeItemKind = "cost_centre" | "account";

/* ------------------------------------------------------------------ *
 * Unassigned spend
 * ------------------------------------------------------------------ */

export interface UnassignedSpendRow {
  /** `unallocated` is spend that resolved to no account or centre; it cannot be assigned. */
  kind: ScopeItemKind | "unallocated";
  /** Cost-centre or account id; null for `unallocated`. */
  id: string | null;
  /** Centres carry their full path ("Engineering → Platform"). */
  name: string;
  /** The account's provider; null for centres and `unallocated`. */
  pluginId: string | null;
  /** Amount per currency, in the currency the providers billed in. */
  amounts: Record<string, number>;
}

export interface UnassignedSpendReport {
  periodFrom: string;
  periodTo: string;
  /** Biggest first, by the sum of its amounts. */
  rows: UnassignedSpendRow[];
  /** Per currency: spend no customer is billed for, spend some customer is, and both. */
  totals: {
    unassigned: Record<string, number>;
    assigned: Record<string, number>;
    all: Record<string, number>;
  };
  /** How many of the rows could be assigned (cost centres and accounts). */
  assignable: number;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function addTo(into: Record<string, number>, currency: string, amount: number): void {
  into[currency] = round6((into[currency] ?? 0) + amount);
}

function sumAmounts(amounts: Record<string, number>): number {
  let total = 0;
  for (const v of Object.values(amounts)) total += Math.abs(v);
  return total;
}

/** "Engineering → Platform", cycle-safe. */
function centrePath(id: string, byId: ReadonlyMap<string, ScopeCentre>): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = id;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const centre = byId.get(cursor);
    if (!centre) break;
    names.unshift(centre.name);
    cursor = centre.parentId;
  }
  return names.join(" → ");
}

/** The id itself and every ancestor, nearest first. Cycle-safe. */
function selfAndAncestors(id: string, byId: ReadonlyMap<string, ScopeCentre>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = id;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    out.push(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return out;
}

/**
 * Which customer bills a bucket, or null for nobody.
 *
 * A centre is billed by whoever names it **or any ancestor** (an invoice bills
 * a centre's whole subtree). An account bucket is billed by whoever names the
 * account.
 */
export function scopeBucketOwner(
  bucket: string,
  centresById: ReadonlyMap<string, ScopeCentre>,
  owners: readonly ScopeOwner[],
): ScopeOwner | null {
  if (!bucket) return null;
  if (bucket.startsWith(ACCOUNT_SCOPE_BUCKET_PREFIX)) {
    const accountId = bucket.slice(ACCOUNT_SCOPE_BUCKET_PREFIX.length);
    return owners.find((o) => o.accountIds.includes(accountId)) ?? null;
  }
  for (const id of selfAndAncestors(bucket, centresById)) {
    const owner = owners.find((o) => o.costCentreIds.includes(id));
    if (owner) return owner;
  }
  return null;
}

/**
 * Spend in the period that no customer is billed for, by cost centre and
 * account.
 *
 * A centre's row is its **direct** spend: its children are rows of their own,
 * so the rows add up to the unassigned total without double counting.
 */
export function classifyUnassignedSpend(input: {
  periodFrom: string;
  periodTo: string;
  buckets: readonly ScopeSpendBucket[];
  centres: readonly ScopeCentre[];
  accounts: readonly ScopeAccount[];
  owners: readonly ScopeOwner[];
}): UnassignedSpendReport {
  const centresById = new Map(input.centres.map((c) => [c.id, c]));
  const accountsById = new Map(input.accounts.map((a) => [a.id, a]));
  const totals = {
    unassigned: {} as Record<string, number>,
    assigned: {} as Record<string, number>,
    all: {} as Record<string, number>,
  };
  const rows = new Map<string, UnassignedSpendRow>();

  for (const b of input.buckets) {
    if (b.amount === 0) continue;
    addTo(totals.all, b.currency, b.amount);

    // A bucket for a centre that no longer exists is spend nobody can be
    // assigned through; it reads as unallocated rather than vanishing.
    let bucket = b.bucket;
    if (bucket && !bucket.startsWith(ACCOUNT_SCOPE_BUCKET_PREFIX) && !centresById.has(bucket)) {
      bucket = "";
    }
    if (bucket.startsWith(ACCOUNT_SCOPE_BUCKET_PREFIX)) {
      const id = bucket.slice(ACCOUNT_SCOPE_BUCKET_PREFIX.length);
      if (!accountsById.has(id)) bucket = "";
    }

    if (scopeBucketOwner(bucket, centresById, input.owners)) {
      addTo(totals.assigned, b.currency, b.amount);
      continue;
    }
    addTo(totals.unassigned, b.currency, b.amount);

    let row = rows.get(bucket);
    if (!row) {
      if (!bucket) {
        row = { kind: "unallocated", id: null, name: "", pluginId: null, amounts: {} };
      } else if (bucket.startsWith(ACCOUNT_SCOPE_BUCKET_PREFIX)) {
        const account = accountsById.get(bucket.slice(ACCOUNT_SCOPE_BUCKET_PREFIX.length))!;
        row = {
          kind: "account",
          id: account.id,
          name: account.displayName,
          pluginId: account.pluginId,
          amounts: {},
        };
      } else {
        row = {
          kind: "cost_centre",
          id: bucket,
          name: centrePath(bucket, centresById),
          pluginId: null,
          amounts: {},
        };
      }
      rows.set(bucket, row);
    }
    addTo(row.amounts, b.currency, b.amount);
  }

  const list = [...rows.values()]
    .filter((r) => Object.values(r.amounts).some((v) => v !== 0))
    .sort((a, b) => sumAmounts(b.amounts) - sumAmounts(a.amounts) || a.name.localeCompare(b.name));
  return {
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    rows: list,
    totals,
    assignable: list.filter((r) => r.kind !== "unallocated").length,
  };
}

/* ------------------------------------------------------------------ *
 * Bulk assignment
 * ------------------------------------------------------------------ */

export interface ManagedAccountAssignmentInput {
  /** The customer to assign to, or null to take the items off every customer. */
  managedAccountId: string | null;
  costCentreIds: string[];
  accountIds: string[];
}

export interface ManagedAccountAssignmentPreviewInput extends ManagedAccountAssignmentInput {
  /** The period whose spend is previewed. Defaults to the last full month. */
  periodFrom?: string | undefined;
  periodTo?: string | undefined;
}

export interface ManagedAccountAssignmentItem {
  kind: ScopeItemKind;
  id: string;
  name: string;
  /** The customer that bills it today, or null. */
  fromManagedAccountId: string | null;
  fromManagedAccountName: string | null;
  /**
   * The spend that moves with it in the previewed period: a centre's whole
   * subtree, an account's spend that no cost centre claimed.
   */
  amounts: Record<string, number>;
  /** Already with the target: nothing to do. */
  unchanged: boolean;
}

export interface ManagedAccountAssignmentPreview {
  periodFrom: string;
  periodTo: string;
  target: { id: string; name: string } | null;
  items: ManagedAccountAssignmentItem[];
  /** Money leaving each current owner (null: currently unassigned), per currency. */
  moves: Array<{
    fromManagedAccountId: string | null;
    fromManagedAccountName: string | null;
    amounts: Record<string, number>;
  }>;
  /** Everything that changes hands, per currency. */
  total: Record<string, number>;
  /** Draft invoices whose figures will change (they recompute from scope). */
  affectedDrafts: number;
  /** Things the person should know before confirming. */
  warnings: string[];
}

/**
 * Describe what an assignment would do, without doing it.
 *
 * Unknown ids are the caller's to refuse; they are skipped here so the preview
 * of a valid selection never fails on a stale one.
 */
export function previewScopeAssignment(input: {
  periodFrom: string;
  periodTo: string;
  assignment: ManagedAccountAssignmentInput;
  buckets: readonly ScopeSpendBucket[];
  centres: readonly ScopeCentre[];
  accounts: readonly ScopeAccount[];
  owners: readonly ScopeOwner[];
  /** Draft invoice counts per customer. */
  draftCounts?: ReadonlyMap<string, number> | undefined;
}): ManagedAccountAssignmentPreview {
  const { assignment, owners } = input;
  const centresById = new Map(input.centres.map((c) => [c.id, c]));
  const accountsById = new Map(input.accounts.map((a) => [a.id, a]));
  const target =
    assignment.managedAccountId === null
      ? null
      : (owners.find((o) => o.id === assignment.managedAccountId) ?? null);

  // Direct spend per bucket, then subtree sums for the centres asked about.
  const direct = new Map<string, Record<string, number>>();
  for (const b of input.buckets) {
    const entry = direct.get(b.bucket) ?? {};
    addTo(entry, b.currency, b.amount);
    direct.set(b.bucket, entry);
  }
  const children = new Map<string, string[]>();
  for (const c of input.centres) {
    if (c.parentId === null || c.parentId === c.id) continue;
    const list = children.get(c.parentId) ?? [];
    list.push(c.id);
    children.set(c.parentId, list);
  }
  const subtreeAmounts = (rootId: string): Record<string, number> => {
    const out: Record<string, number> = {};
    const seen = new Set<string>();
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const [currency, amount] of Object.entries(direct.get(id) ?? {})) {
        addTo(out, currency, amount);
      }
      for (const child of children.get(id) ?? []) stack.push(child);
    }
    return out;
  };

  const items: ManagedAccountAssignmentItem[] = [];
  const warnings: string[] = [];
  for (const id of new Set(assignment.costCentreIds)) {
    const centre = centresById.get(id);
    if (!centre) continue;
    const owner = owners.find((o) => o.costCentreIds.includes(id)) ?? null;
    items.push({
      kind: "cost_centre",
      id,
      name: centrePath(id, centresById),
      fromManagedAccountId: owner?.id ?? null,
      fromManagedAccountName: owner?.name ?? null,
      amounts: subtreeAmounts(id),
      unchanged: (owner?.id ?? null) === (target?.id ?? null),
    });
    // An ancestor named on a *different* customer bills this subtree already;
    // naming the child as well would bill it twice.
    const ancestors = selfAndAncestors(id, centresById).slice(1);
    for (const ancestorId of ancestors) {
      const ancestorOwner = owners.find((o) => o.costCentreIds.includes(ancestorId));
      if (ancestorOwner && ancestorOwner.id !== target?.id && target !== null) {
        warnings.push(
          `${centrePath(id, centresById)} sits under ${centrePath(ancestorId, centresById)}, ` +
            `which "${ancestorOwner.name}" is billed for. Its spend would be billed to both.`,
        );
        break;
      }
    }
  }
  for (const id of new Set(assignment.accountIds)) {
    const account = accountsById.get(id);
    if (!account) continue;
    const owner = owners.find((o) => o.accountIds.includes(id)) ?? null;
    items.push({
      kind: "account",
      id,
      name: account.displayName,
      fromManagedAccountId: owner?.id ?? null,
      fromManagedAccountName: owner?.name ?? null,
      amounts: { ...(direct.get(`${ACCOUNT_SCOPE_BUCKET_PREFIX}${id}`) ?? {}) },
      unchanged: (owner?.id ?? null) === (target?.id ?? null),
    });
  }

  const moves = new Map<string, ManagedAccountAssignmentPreview["moves"][number]>();
  const total: Record<string, number> = {};
  const touched = new Set<string>();
  for (const item of items) {
    if (item.unchanged) continue;
    const key = item.fromManagedAccountId ?? "";
    const move = moves.get(key) ?? {
      fromManagedAccountId: item.fromManagedAccountId,
      fromManagedAccountName: item.fromManagedAccountName,
      amounts: {},
    };
    for (const [currency, amount] of Object.entries(item.amounts)) {
      addTo(move.amounts, currency, amount);
      addTo(total, currency, amount);
    }
    moves.set(key, move);
    if (item.fromManagedAccountId) touched.add(item.fromManagedAccountId);
    if (target) touched.add(target.id);
  }

  let affectedDrafts = 0;
  for (const id of touched) affectedDrafts += input.draftCounts?.get(id) ?? 0;

  return {
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    target: target ? { id: target.id, name: target.name } : null,
    items,
    moves: [...moves.values()],
    total,
    affectedDrafts,
    warnings,
  };
}

/**
 * The new scope of every customer an assignment touches: each item taken off
 * whoever holds it and, unless the target is null, added to the target.
 * Customers whose scope does not change are left out.
 *
 * Order is preserved: items keep their place on the customers that keep them,
 * and new ones are appended in the order they were asked for, which is the
 * order a customer's editor shows them in.
 */
export function applyScopeAssignment(
  owners: readonly ScopeOwner[],
  assignment: ManagedAccountAssignmentInput,
): Array<{ id: string; costCentreIds: string[]; accountIds: string[] }> {
  const centres = [...new Set(assignment.costCentreIds)];
  const accounts = [...new Set(assignment.accountIds)];
  const centreSet = new Set(centres);
  const accountSet = new Set(accounts);
  const out: Array<{ id: string; costCentreIds: string[]; accountIds: string[] }> = [];

  for (const owner of owners) {
    const isTarget = owner.id === assignment.managedAccountId;
    let costCentreIds = owner.costCentreIds.filter((id) => isTarget || !centreSet.has(id));
    let accountIds = owner.accountIds.filter((id) => isTarget || !accountSet.has(id));
    if (isTarget) {
      costCentreIds = [...costCentreIds, ...centres.filter((id) => !costCentreIds.includes(id))];
      accountIds = [...accountIds, ...accounts.filter((id) => !accountIds.includes(id))];
    }
    const same = (a: readonly string[], b: readonly string[]) =>
      a.length === b.length && a.every((v, i) => v === b[i]);
    if (!same(costCentreIds, owner.costCentreIds) || !same(accountIds, owner.accountIds)) {
      out.push({ id: owner.id, costCentreIds, accountIds });
    }
  }
  return out;
}

/** "1,234.50 USD + 80.00 EUR", biggest first; "nothing" when empty. */
export function describeScopeAmounts(amounts: Record<string, number>): string {
  const entries = Object.entries(amounts).filter(([, v]) => v !== 0);
  if (entries.length === 0) return "nothing";
  return entries
    .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
    .map(([currency, amount]) => `${amount.toFixed(2)} ${currency}`)
    .join(" + ");
}

/** The last complete calendar month, relative to `now`. */
export function lastFullMonth(now: Date = new Date()): { from: string; to: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}
