/**
 * Cost collection for Devin, from the v3 consumption endpoints (checked
 * 2026-10 against https://docs.devin.ai/v3-openapi.json):
 *
 * - `GET /v3/organizations/{org}/consumption/daily`: the organization's ACUs
 *   per billing day, split by product (`acus_by_product`). Available on every
 *   plan, permission `ViewOrgConsumption`.
 * - `…/consumption/daily/users/{user_id}` and `…/service-users/{id}`: the same
 *   for one person or service user.
 * - `…/consumption/daily/sessions/{session_id}`: the same for one session.
 *
 * Billing days start at midnight PST, 08:00 UTC, and the `date` Devin returns
 * is that boundary as Unix seconds; a row's `date` is that day's calendar date.
 *
 * **Attribution, finest first.** Sessions carry who started them, their
 * playbook and their tags, so session-level rows are what make cost
 * breakdowns by user, playbook and session tag possible. A session that began
 * and was last updated on the same billing day spent all its ACUs that day,
 * so its lifetime `acus_consumed` is that day's amount with no extra call;
 * only sessions spanning several days cost a per-session request (capped per
 * pass). Whatever a person's daily total has left once their sessions are
 * taken out (Cascade, the terminal, Devin Review, or capped sessions) becomes
 * a row tagged with just the user, and whatever the organization total has
 * left once every person is taken out becomes an organization-only row.
 *
 * Each level is scaled down if it would exceed the level above it, so the
 * rows for a day and product always add up to exactly the organization's
 * total: the organization figure is the one that is billed.
 *
 * ACUs carry no price, so amounts are ACUs times the configured price per
 * ACU and the manifest declares `estimated` (see `pricing.ts`).
 */

import type { CostFetchRange, CostFetchResult, CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import type {
  ConsumptionDay,
  DevinContext,
  DevinOrg,
  DevinPlaybook,
  DevinSelf,
  DevinSession,
  DevinUser,
} from "./api.js";
import {
  billingDay,
  dayStartSeconds,
  fetchConsumption,
  isPermissionError,
  mapLimit,
  orgPath,
  paginate,
  statusOf,
} from "./api.js";
import { orgLabel, scopedId, userLabel } from "./mappers.js";
import type { AcusByProduct, ProductKey } from "./pricing.js";
import { PRODUCT_KEYS, PRODUCT_LABELS, roundMoney } from "./pricing.js";

/** Per-session consumption requests allowed per organization per pass. */
export const MAX_SESSION_LOOKUPS = 400;
const CONCURRENCY = 4;
const EPSILON = 1e-9;

type ProductSplit = Record<ProductKey, number>;

const emptySplit = (): ProductSplit =>
  Object.fromEntries(PRODUCT_KEYS.map((k) => [k, 0])) as ProductSplit;

/**
 * A day's ACUs per product. The buckets are documented to sum to `acus`;
 * anything they leave over (a bucket Devin reports as null) goes to Devin
 * sessions, the product every plan has.
 */
export function splitDay(day: Pick<ConsumptionDay, "acus" | "acus_by_product">): ProductSplit {
  const out = emptySplit();
  const by: AcusByProduct = day.acus_by_product ?? {};
  let sum = 0;
  for (const k of PRODUCT_KEYS) {
    const v = by[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      out[k] = v;
      sum += v;
    }
  }
  const rest = (Number.isFinite(day.acus) ? day.acus : 0) - sum;
  if (rest > EPSILON) out.devin += rest;
  return out;
}

/** Who spent the ACUs: a person, a service user, or nobody we can name. */
interface Principal {
  key: string;
  kind: "user" | "service-user";
  id: string;
  label: string;
}

interface SessionShare {
  session: DevinSession;
  acus: number;
}

/** `day -> principal -> product -> value`. */
type Cube<T> = Map<string, Map<string, Map<ProductKey, T>>>;

function cubeCell<T>(
  cube: Cube<T>,
  day: string,
  principal: string,
  product: ProductKey,
  init: () => T,
): T {
  let byPrincipal = cube.get(day);
  if (!byPrincipal) cube.set(day, (byPrincipal = new Map()));
  let byProduct = byPrincipal.get(principal);
  if (!byProduct) byPrincipal.set(principal, (byProduct = new Map()));
  let cell = byProduct.get(product);
  if (cell === undefined) byProduct.set(product, (cell = init()));
  return cell;
}

const principalKeyOf = (s: DevinSession) =>
  s.user_id ? `user:${s.user_id}` : s.service_user_id ? `service-user:${s.service_user_id}` : "";

export interface OrgCostInput {
  org: DevinOrg;
  orgDays: ConsumptionDay[];
  principals: Principal[];
  /** Daily consumption per principal key; absent when it could not be read. */
  principalDays: Map<string, ConsumptionDay[]>;
  sessions: SessionShareInput[];
  playbooks: Map<string, DevinPlaybook>;
  acuPrice: number;
  range: CostFetchRange;
}

/** One session's consumption, per billing day and product. */
export interface SessionShareInput {
  session: DevinSession;
  days: Array<{ day: string; split: ProductSplit }>;
}

/** Pure allocation: the rows for one organization. Exported for tests. */
export function allocateOrgRows(input: OrgCostInput): CostRow[] {
  const { org, range, acuPrice } = input;
  const inRange = (day: string) => day >= range.fromDate && day <= range.toDate;
  const orgTag = orgLabel(org);
  const labels = new Map(input.principals.map((p) => [p.key, p.label]));

  // Level 0: the organization's billed totals.
  const orgCells = new Map<string, ProductSplit>();
  for (const d of input.orgDays) {
    const day = billingDay(d.date);
    if (!inRange(day)) continue;
    const split = splitDay(d);
    const prev = orgCells.get(day);
    if (prev) for (const k of PRODUCT_KEYS) prev[k] += split[k];
    else orgCells.set(day, split);
  }

  // Level 1: each principal's totals.
  const principalCells: Cube<number> = new Map();
  for (const [key, days] of input.principalDays) {
    for (const d of days) {
      const day = billingDay(d.date);
      if (!inRange(day)) continue;
      const split = splitDay(d);
      for (const k of PRODUCT_KEYS) {
        if (split[k] <= EPSILON) continue;
        const byProduct = cubeCell(principalCells, day, key, k, () => 0);
        principalCells
          .get(day)!
          .get(key)!
          .set(k, byProduct + split[k]);
      }
    }
  }

  // Level 2: sessions, filed under their principal.
  const sessionCells: Cube<SessionShare[]> = new Map();
  for (const share of input.sessions) {
    const key = principalKeyOf(share.session);
    for (const { day, split } of share.days) {
      if (!inRange(day)) continue;
      for (const k of PRODUCT_KEYS) {
        if (split[k] <= EPSILON) continue;
        cubeCell(sessionCells, day, key, k, () => [] as SessionShare[]).push({
          session: share.session,
          acus: split[k],
        });
      }
    }
  }

  const rows: CostRow[] = [];
  const emit = (
    day: string,
    product: ProductKey,
    acus: number,
    tags: Record<string, string>,
    resourceId?: string,
  ) => {
    if (acus <= EPSILON) return;
    rows.push({
      date: day,
      service: PRODUCT_LABELS[product],
      ...(resourceId ? { resourceId } : {}),
      tags,
      currency: "USD",
      amount: roundMoney(acus * acuPrice),
      usageAmount: roundMoney(acus),
      usageUnit: "ACU",
    });
  };

  const days = new Set<string>([
    ...orgCells.keys(),
    ...principalCells.keys(),
    ...sessionCells.keys(),
  ]);
  for (const day of [...days].sort()) {
    for (const product of PRODUCT_KEYS) {
      // Every principal with either a total or sessions on this day/product.
      const keys = new Set<string>();
      for (const [key, byProduct] of principalCells.get(day) ?? []) {
        if (byProduct.has(product)) keys.add(key);
      }
      for (const [key, byProduct] of sessionCells.get(day) ?? []) {
        if (byProduct.has(product)) keys.add(key);
      }

      // Within each principal: sessions, scaled to fit the principal's total.
      const perPrincipal = [...keys].map((key) => {
        const shares = sessionCells.get(day)?.get(key)?.get(product) ?? [];
        const sessionSum = shares.reduce((a, s) => a + s.acus, 0);
        const known = principalCells.get(day)?.get(key)?.get(product);
        // No readable total for this principal: its sessions are its total.
        const total = key && known !== undefined ? known : sessionSum;
        const scale = sessionSum > total && sessionSum > 0 ? total / sessionSum : 1;
        return { key, shares, scale, total, residual: Math.max(0, total - sessionSum) };
      });

      // Across principals: scaled to fit the organization's total.
      const principalSum = perPrincipal.reduce((a, p) => a + p.total, 0);
      const orgTotal = orgCells.get(day)?.[product] ?? principalSum;
      const orgScale = principalSum > orgTotal && principalSum > 0 ? orgTotal / principalSum : 1;

      for (const p of perPrincipal) {
        const user = p.key ? labels.get(p.key) : undefined;
        for (const share of p.shares) {
          const s = share.session;
          const tags: Record<string, string> = { organization: orgTag };
          if (user) tags["user"] = user;
          if (s.playbook_id) {
            tags["playbook"] = input.playbooks.get(s.playbook_id)?.title || s.playbook_id;
          }
          const sessionTags = [...new Set(s.tags ?? [])].sort();
          if (sessionTags.length) tags["session_tag"] = sessionTags.join("+");
          if (s.origin) tags["origin"] = s.origin;
          if (s.category) tags["category"] = s.category;
          emit(
            day,
            product,
            share.acus * p.scale * orgScale,
            tags,
            scopedId(org.org_id, s.session_id),
          );
        }
        const tags: Record<string, string> = { organization: orgTag };
        if (user) tags["user"] = user;
        emit(day, product, p.residual * orgScale, tags);
      }
      emit(day, product, Math.max(0, orgTotal - principalSum), { organization: orgTag });
    }
  }
  return rows;
}

/** The days and products a session spent its ACUs on, without a request where possible. */
function singleDayShare(s: DevinSession): SessionShareInput | undefined {
  const acus = s.acus_consumed ?? 0;
  if (!(acus > 0) || !s.created_at || !s.updated_at) return undefined;
  const day = billingDay(s.created_at);
  if (billingDay(s.updated_at) !== day) return undefined;
  const split = emptySplit();
  split[s.automation_id ? "automation" : "devin"] = acus;
  return { session: s, days: [{ day, split }] };
}

async function collectOrg(
  ctx: DevinContext,
  org: DevinOrg,
  self: DevinSelf,
  acuPrice: number,
  range: CostFetchRange,
): Promise<{ rows: CostRow[]; degraded: boolean }> {
  const orgDays = await fetchConsumption(
    ctx,
    orgPath(org.org_id, "/consumption/daily"),
    range.fromDate,
    range.toDate,
  );
  if (!orgDays.some((d) => d.acus > EPSILON)) return { rows: [], degraded: false };

  let degraded = false;
  const soft = async <T>(load: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await load();
    } catch (err) {
      if (isPermissionError(err) || statusOf(err) === 404) {
        degraded = true;
        return fallback;
      }
      throw err;
    }
  };

  const [users, sessions, playbookList] = await Promise.all([
    soft(
      () =>
        paginate<DevinUser>(
          ctx,
          `/v3beta1/organizations/${encodeURIComponent(org.org_id)}/members/users`,
        ),
      [],
    ),
    soft(
      () =>
        paginate<DevinSession>(ctx, orgPath(org.org_id, "/sessions"), {
          updated_after: dayStartSeconds(range.fromDate),
        }),
      [] as DevinSession[],
    ),
    soft(() => paginate<DevinPlaybook>(ctx, orgPath(org.org_id, "/playbooks")), []),
  ]);

  const principals = new Map<string, Principal>();
  for (const u of users) {
    principals.set(`user:${u.user_id}`, {
      key: `user:${u.user_id}`,
      kind: "user",
      id: u.user_id,
      label: userLabel(u),
    });
  }
  for (const s of sessions) {
    if (s.user_id && !principals.has(`user:${s.user_id}`)) {
      principals.set(`user:${s.user_id}`, {
        key: `user:${s.user_id}`,
        kind: "user",
        id: s.user_id,
        label: s.user_id,
      });
    }
    if (!s.user_id && s.service_user_id && !principals.has(`service-user:${s.service_user_id}`)) {
      const name =
        s.service_user_id === self.service_user_id && self.service_user_name
          ? self.service_user_name
          : `Service user ${s.service_user_id}`;
      principals.set(`service-user:${s.service_user_id}`, {
        key: `service-user:${s.service_user_id}`,
        kind: "service-user",
        id: s.service_user_id,
        label: name,
      });
    }
  }

  const principalList = [...principals.values()];
  const principalDays = new Map<string, ConsumptionDay[]>();
  await mapLimit(principalList, CONCURRENCY, async (p) => {
    const path = orgPath(
      org.org_id,
      `/consumption/daily/${p.kind === "user" ? "users" : "service-users"}/${encodeURIComponent(p.id)}`,
    );
    const days = await soft(
      () => fetchConsumption(ctx, path, range.fromDate, range.toDate),
      undefined,
    );
    if (days) principalDays.set(p.key, days);
  });

  const shares: SessionShareInput[] = [];
  const multiDay: DevinSession[] = [];
  for (const s of sessions) {
    if (!((s.acus_consumed ?? 0) > 0)) continue;
    const single = singleDayShare(s);
    if (single) shares.push(single);
    else multiDay.push(s);
  }
  // Most recently active first, so a capped pass keeps the sessions most
  // likely to sit inside the restatement window.
  multiDay.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  if (multiDay.length > MAX_SESSION_LOOKUPS) degraded = true;
  const looked = await mapLimit(multiDay.slice(0, MAX_SESSION_LOOKUPS), CONCURRENCY, async (s) => {
    const path = orgPath(
      org.org_id,
      `/consumption/daily/sessions/${encodeURIComponent(s.session_id)}`,
    );
    const days = await soft(
      () => fetchConsumption(ctx, path, range.fromDate, range.toDate),
      undefined,
    );
    if (!days) return undefined;
    return { session: s, days: days.map((d) => ({ day: billingDay(d.date), split: splitDay(d) })) };
  });
  for (const share of looked) if (share) shares.push(share);

  const rows = allocateOrgRows({
    org,
    orgDays,
    principals: principalList,
    principalDays,
    sessions: shares,
    playbooks: new Map(playbookList.map((p) => [p.playbook_id, p])),
    acuPrice,
    range,
  });
  return { rows, degraded };
}

export async function fetchDevinCostData(
  ctx: DevinContext,
  orgs: DevinOrg[],
  self: DevinSelf,
  acuPrice: number,
  range: CostFetchRange,
): Promise<CostFetchResult> {
  const rows: CostRow[] = [];
  let degraded = false;
  let denied = 0;
  for (const org of orgs) {
    try {
      const out = await collectOrg(ctx, org, self, acuPrice, range);
      rows.push(...out.rows);
      degraded ||= out.degraded;
    } catch (err) {
      if (!isPermissionError(err)) throw err;
      denied++;
    }
  }
  if (orgs.length > 0 && denied === orgs.length) {
    throw new CostSetupError(
      "Devin refused to show consumption. Give the service user a role with the View Org Consumption permission (or View Account Consumption for an enterprise service user), then collect again.",
      { label: "Devin API permissions", url: "https://docs.devin.ai/api-reference/v3/overview" },
    );
  }
  return { rows, degraded };
}
