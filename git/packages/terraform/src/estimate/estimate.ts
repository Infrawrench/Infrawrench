/**
 * A root's monthly cost as its configuration describes it, once priced, and
 * the difference between two of them (a branch's head against its base).
 *
 * Priced by the app on the gateway (server-core `git-terraform/config-cost.ts`),
 * from list prices; stored on the scan for the forge to show. **Null is not
 * zero**: what could not be priced is listed, and `complete` is false while
 * anything that may cost money was left out.
 */

export interface ConfigurationCostLine {
  readonly address: string;
  readonly type: string;
  readonly count: number;
  /** All of its instances, a month. */
  readonly monthly: number;
  /** How it was priced, for a person: `2 × t3.medium, us-east-1, on demand`. */
  readonly detail: string;
}

export interface ConfigurationUnpriced {
  readonly address: string;
  readonly type: string;
  /** A sentence: why no price (`instance_type is set from a resource`, `no list price for db.x9.huge in us-east-1`). */
  readonly reason: string;
}

export interface ConfigurationOther {
  readonly type: string;
  readonly count: number;
  /** `usage`: billed by what it does (requests, bytes), so a configuration cannot say. `free`: no charge of its own. `unknown`: no price data for the type. */
  readonly kind: "usage" | "free" | "unknown";
}

export interface ConfigurationEstimate {
  readonly currency: string | null;
  /** The priced lines' sum, a month. Null when nothing was priced. */
  readonly monthlyTotal: number | null;
  /** Nothing that may cost a fixed amount was left out (`unpriced` is empty, no `unknown` other). */
  readonly complete: boolean;
  /** Most expensive first. */
  readonly lines: readonly ConfigurationCostLine[];
  readonly unpriced: readonly ConfigurationUnpriced[];
  readonly others: readonly ConfigurationOther[];
}

export interface ConfigurationCostChangeLine {
  readonly address: string;
  readonly type: string;
  readonly monthlyBefore: number | null;
  readonly monthlyAfter: number | null;
  readonly monthlyDelta: number;
}

export interface ConfigurationCostChange {
  readonly currency: string | null;
  readonly monthlyBefore: number | null;
  readonly monthlyAfter: number | null;
  /** After less before. Null when either side has no price at all. */
  readonly monthlyDelta: number | null;
  /** Both sides are complete and in one currency. */
  readonly complete: boolean;
  /** Resources whose price changed, largest change first. */
  readonly lines: readonly ConfigurationCostChangeLine[];
  /** What the head cannot price that the base did not already fail to. */
  readonly unpriced: readonly ConfigurationUnpriced[];
}

const round = (amount: number): number => Math.round(amount * 100) / 100;

/**
 * What a change does to a root's estimate. A root the base does not have is
 * all added; one the head does not have, all removed.
 */
export function compareConfigurationEstimates(
  before: ConfigurationEstimate | null,
  after: ConfigurationEstimate | null,
): ConfigurationCostChange {
  const currency = after?.currency ?? before?.currency ?? null;
  const sameCurrency =
    before === null ||
    after === null ||
    before.currency === null ||
    after.currency === null ||
    before.currency === after.currency;
  const was = new Map((before?.lines ?? []).map((line) => [line.address, line]));
  const now = new Map((after?.lines ?? []).map((line) => [line.address, line]));
  const lines: ConfigurationCostChangeLine[] = [];
  for (const address of new Set([...was.keys(), ...now.keys()])) {
    const a = was.get(address);
    const b = now.get(address);
    const delta = round((b?.monthly ?? 0) - (a?.monthly ?? 0));
    if (delta === 0) continue;
    lines.push({
      address,
      type: (b ?? a)!.type,
      monthlyBefore: a ? round(a.monthly) : null,
      monthlyAfter: b ? round(b.monthly) : null,
      monthlyDelta: delta,
    });
  }
  lines.sort(
    (x, y) =>
      Math.abs(y.monthlyDelta) - Math.abs(x.monthlyDelta) || (x.address < y.address ? -1 : 1),
  );
  const failedBefore = new Set(
    (before?.unpriced ?? []).map((item) => `${item.address}\u0000${item.reason}`),
  );
  const unpriced = (after?.unpriced ?? []).filter(
    (item) => !failedBefore.has(`${item.address}\u0000${item.reason}`),
  );
  const total = (side: ConfigurationEstimate | null): number | null =>
    side === null ? 0 : side.monthlyTotal;
  const monthlyBefore = total(before);
  const monthlyAfter = total(after);
  return {
    currency,
    monthlyBefore: monthlyBefore === null ? null : round(monthlyBefore),
    monthlyAfter: monthlyAfter === null ? null : round(monthlyAfter),
    monthlyDelta:
      monthlyBefore === null || monthlyAfter === null || !sameCurrency
        ? null
        : round(monthlyAfter - monthlyBefore),
    complete: sameCurrency && (before?.complete ?? true) && (after?.complete ?? true),
    lines,
    unpriced,
  };
}
