/**
 * Blended commitment discounts: the arithmetic every plugin shares.
 *
 * A commitment's discount lands wherever the provider happened to apply it.
 * AWS applies a Savings Plan to the usage with the highest discount first, a
 * regional Reserved Instance to whichever matching hours ran first, and a GCP
 * committed-use discount to the projects that happened to be consuming when
 * the commitment had headroom. On the amortized basis that is faithful to the
 * bill and unfair to the teams reading it: two teams running identical
 * workloads in the same scope pay very different effective rates, and the
 * difference is an accident of scheduling.
 *
 * The blended basis spreads the discount evenly instead. Within one *pool*
 * (the usage a set of commitments was eligible to cover on one day, in one
 * currency) every member is re-priced at the same effective rate:
 *
 *     rate      = Σ effective cost  /  Σ on-demand-equivalent cost
 *     blended_i = on-demand-equivalent_i × rate
 *
 * so each eligible hour carries the same share of the discount, whichever
 * hour the provider applied it to. **The pool total is preserved**:
 * Σ blended = Σ effective by construction (the last weighted member absorbs
 * the floating-point remainder), and members outside any pool keep their
 * amortized amount, so every day's total is the amortized total, exactly.
 *
 * What a pool is, and what a member's on-demand equivalent is, are provider
 * questions answered in each plugin. This file only does the division.
 */

/** One row's part in a blending pool. */
export interface BlendMember {
  /**
   * Pool key. Members sharing a key are blended together; callers fold the
   * day and currency into it, because a rate across days or currencies is
   * meaningless.
   */
  pool: string;
  /** The row's amortized (effective) amount: the money the pool redistributes. */
  effective: number;
  /**
   * The row's on-demand-equivalent cost, the weight its share is computed
   * from. `null` means the provider did not say, and makes the whole pool
   * unblendable: weighting a pool with a guessed member would move money
   * between teams on the strength of the guess.
   */
  weight: number | null;
  /**
   * True for usage a commitment actually covered. A pool with no covered
   * member is plain on-demand usage whose blended amount equals its amortized
   * amount, so it is skipped rather than written twice.
   */
  covered?: boolean;
}

/**
 * Split `total` across `weights` in proportion, preserving the total.
 *
 * Every share is `weight / Σweight × total` except the last non-zero one,
 * which takes the remainder, so the shares always sum back to `total` rather
 * than drifting by a rounding error per member. Returns `null` when the split
 * is undefined: no positive weight, or a negative or non-finite one.
 */
export function allocateProportionally(total: number, weights: number[]): number[] | null {
  if (!Number.isFinite(total)) return null;
  let sum = 0;
  let last = -1;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]!;
    if (!Number.isFinite(w) || w < 0) return null;
    sum += w;
    if (w > 0) last = i;
  }
  if (last < 0 || sum <= 0) return null;
  const shares = weights.map(() => 0);
  let assigned = 0;
  for (let i = 0; i < weights.length; i++) {
    if (i === last) continue;
    const share = (weights[i]! / sum) * total;
    shares[i] = share;
    assigned += share;
  }
  shares[last] = total - assigned;
  return shares;
}

/**
 * Blend every pool in `members`, returning the blended amount per index.
 *
 * `undefined` means "no blended opinion" (the member is in no pool, or its
 * pool could not be blended), and the plugin should leave
 * `CostRow.blendedAmount` unset so readers fall back to the amortized
 * amount. A pool is blended only when every member has a finite,
 * non-negative weight and effective amount, the weights sum to more than
 * zero, and at least one member is commitment-covered.
 */
export function blendCommitmentPools(
  members: ReadonlyArray<BlendMember | null | undefined>,
): Array<number | undefined> {
  const pools = new Map<string, number[]>();
  members.forEach((m, i) => {
    if (!m) return;
    const list = pools.get(m.pool);
    if (list) list.push(i);
    else pools.set(m.pool, [i]);
  });

  const out: Array<number | undefined> = members.map(() => undefined);
  for (const indices of pools.values()) {
    const pool = indices.map((i) => members[i]!);
    if (!pool.some((m) => m.covered)) continue;
    if (pool.some((m) => m.weight === null || !Number.isFinite(m.effective) || m.effective < 0)) {
      continue;
    }
    const total = pool.reduce((s, m) => s + m.effective, 0);
    const shares = allocateProportionally(
      total,
      pool.map((m) => m.weight as number),
    );
    if (!shares) continue;
    indices.forEach((memberIndex, j) => {
      out[memberIndex] = shares[j]!;
    });
  }
  return out;
}
