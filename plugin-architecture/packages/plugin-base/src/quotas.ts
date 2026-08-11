/**
 * The quota contract: how close an account is to a limit its provider will
 * enforce, before the provider enforces it.
 *
 * This is deliberately not part of the cost contract and not part of the
 * metric contract, and both separations are load-bearing:
 *
 * - A quota is **not spend**. Running out of Elastic IPs costs nothing and
 *   breaks everything; a budget can be over by 40% and nothing stops working.
 *   The two answer different questions and reading one as the other is how a
 *   "we're only at 60% of budget" report sits next to a failed deploy.
 * - A quota is **not a metric**. A metric is a number the provider samples
 *   continuously and we store as a series; a quota is a *pair* — a used figure
 *   and a limit — where the interesting value is the ratio, the limit moves
 *   when a support ticket is approved, and the reading comes from a management
 *   API on a cadence measured in hours. Storing it as a metric would lose the
 *   limit, which is the half that makes the number mean anything.
 *
 * The shape is a snapshot, not a series: plugins report what the provider says
 * right now, and the host builds the trend by reading repeatedly. That is the
 * `credits` stance, for the same reason — the provider will not tell you what
 * your vCPU usage was last Tuesday, so the only honest history is the one we
 * recorded ourselves.
 *
 * **Every figure here is the provider's own.** A plugin must never compute a
 * limit from documentation, a pricing page or its own memory of the defaults:
 * an account with an approved increase would then be reported as exhausted
 * while it has headroom, which is a false alarm about the one thing this
 * feature exists to be trusted about. When a provider publishes limits only in
 * prose and not in an API, the honest answer is to report nothing — see
 * {@link QuotaCapabilityDeclaration} on why absence must never render as zero.
 */

/**
 * One quota reading for one account.
 *
 * `used` and `limit` are in the same unit and both come from the provider.
 * Utilisation is `used / limit` and is computed by the host, once, so every
 * surface agrees — a plugin that pre-divides would be reporting a number the
 * host cannot re-derive when the limit later moves.
 */
export interface QuotaUsage {
  /**
   * Stable identity for this quota within the account, so successive
   * collections line up into a series.
   *
   * Must be stable across collections and must not embed the reading: an id
   * derived from the provider's own quota code and scope (`ec2/L-1216C47A`,
   * `compute/CPUS/europe-west1`) survives a limit increase, whereas one built
   * from the label or the value starts a fresh, empty trend the moment
   * anything changes — which is exactly when the trend is worth having.
   */
  id: string;
  /**
   * Provider service the quota belongs to, in the provider's own vocabulary
   * (`ec2`, `vpc`, `compute`, `account`). Groups the rows on the surface.
   */
  service: string;
  /** Human label, the provider's own wording ("Running On-Demand Standard instances"). */
  name: string;
  /**
   * Provider region this quota applies in. Omitted — never `"global"` — for a
   * quota that genuinely has no region, because the surface renders an absent
   * region as "account-wide" and a literal `"global"` as a region called
   * global that no provider has.
   */
  region?: string;
  /**
   * The ceiling the provider will enforce, in `unit`. Must be > 0: a zero
   * limit makes utilisation undefined, and a provider reporting one is
   * reporting "this quota does not apply to you", which is not a row.
   */
  limit: number;
  /** How much of `limit` is currently consumed, in the same unit. */
  used: number;
  /**
   * What is being counted (`vCPUs`, `addresses`, `GB`). Free text because
   * every provider names these differently and normalising would only produce
   * a word the user cannot find in their own console. Absent renders as a bare
   * count.
   */
  unit?: string;
  /**
   * True when the provider lets the customer request an increase. Drives the
   * surface's call to action: an adjustable quota near its ceiling has a fix,
   * a hard one means the workload has to change instead. Absent means the
   * plugin does not know, which is rendered as "unknown" rather than as "no".
   */
  adjustable?: boolean;
  /** Provider docs page for this quota, when the plugin knows a specific one. */
  docsUrl?: string;
}

/**
 * Declared by a plugin whose client implements `fetchQuotas`.
 *
 * Its presence is what makes the host schedule a quota pass for the plugin's
 * accounts. Its absence means the surface shows **nothing** for those accounts
 * — never zero, never "0% used". An org whose provider exposes no quota API
 * and an org genuinely nowhere near its limits are not the same org, and a
 * screen that renders them identically is worse than one that admits it does
 * not know.
 *
 * The static half lives on the manifest (rather than being inferred from the
 * method's presence) so the host can answer "which of my providers can tell me
 * this?" without loading credentials — the same discovery reason `costs` and
 * `credits` are declared.
 */
export interface QuotaCapabilityDeclaration {
  /**
   * What the provider calls it, for the UI: "Service Quotas", "Quotas",
   * "Limits". Defaults to "Quotas" when absent. The provider's own word
   * matters because the user's next step is to go and look for it in the
   * provider's console.
   */
  label?: string;
  /**
   * Where the user requests an increase. Rendered as the row's action for an
   * adjustable quota. A per-quota `docsUrl` on the reading wins over this.
   */
  increaseUrl?: string;
  /**
   * True when the plugin reports a *representative subset* rather than every
   * quota the provider enforces.
   *
   * AWS alone publishes thousands of quotas across hundreds of services, and
   * walking them all is both unaffordable and useless. Declaring the subset
   * honestly is what stops the surface implying "you are within all your
   * limits" when what it actually knows is "you are within the eleven limits
   * we asked about".
   */
  partial?: boolean;
  /**
   * True when reading quotas requires a permission beyond what the account's
   * normal credential carries (AWS needs `servicequotas:ListServiceQuotas`
   * plus `cloudwatch:GetMetricData`). The host explains a missing reading as a
   * permission gap rather than as a failure.
   */
  requiresElevatedCredential?: boolean;
}

/**
 * Thrown by `fetchQuotas` when the quotas cannot be read until the user does
 * something — usually attaching a policy or enabling an API.
 *
 * Distinct from a transient failure for the reason {@link CreditAccessError}
 * and `NetworkFlowSetupError` are: "your credential cannot see this" and "the
 * provider is down" want completely different reactions, and a host that
 * cannot tell them apart either retries forever or gives up on a fixable
 * problem.
 */
export class QuotaAccessError extends Error {
  readonly helpLabel: string | undefined;
  readonly helpUrl: string | undefined;

  constructor(message: string, help?: { label: string; url: string }) {
    super(message);
    this.name = "QuotaAccessError";
    this.helpLabel = help?.label;
    this.helpUrl = help?.url;
  }
}

/**
 * Drop readings that cannot mean anything, and clamp the ones that can.
 *
 * Shared rather than left to each plugin because every provider produces at
 * least one of these and the wrong handling of each is a different flavour of
 * lie:
 *
 * - A **non-finite or non-positive limit** is dropped. AWS returns `Value: 0`
 *   for quotas that do not apply to an account and GCP returns `limit: -1` for
 *   unlimited; both divide into a utilisation that is either infinite or
 *   negative, and both would sort straight to the top of a list ordered by
 *   "closest to the ceiling".
 * - A **negative used** is clamped to zero rather than dropped. It only comes
 *   from a provider arithmetic glitch, and losing the whole row would also
 *   lose the limit.
 * - `used > limit` is **kept as-is**. Over-quota is a real state (a limit
 *   lowered under existing usage, a soft limit the provider let through) and
 *   clamping it to 100% would hide the one reading nobody should miss.
 */
export function normalizeQuotaUsage(readings: QuotaUsage[]): QuotaUsage[] {
  const out: QuotaUsage[] = [];
  const seen = new Set<string>();
  for (const reading of readings) {
    if (!reading.id || !Number.isFinite(reading.limit) || reading.limit <= 0) continue;
    if (!Number.isFinite(reading.used)) continue;
    // A duplicate id would make the snapshot's primary key ambiguous and the
    // trend jump between two unrelated series. First wins, deterministically.
    if (seen.has(reading.id)) continue;
    seen.add(reading.id);
    out.push({ ...reading, used: Math.max(0, reading.used) });
  }
  return out;
}

/**
 * Utilisation as a fraction of the limit. Defined in one place because the
 * poller's alert threshold, the digest line and the utilisation bar must all
 * agree — three implementations of `used / limit` is three chances to round
 * 79.6% to 80% in only two of them.
 *
 * Never clamped at 1: see {@link normalizeQuotaUsage}.
 */
export function quotaUtilization(used: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return used / limit;
}
