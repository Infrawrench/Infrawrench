import {
  emptyCostAccounts,
  estimatedCostAccounts,
  failingCostAccounts,
  type CostAccountStatus,
} from "@infrawrench/client-core";

export interface CostCollectionNoticeProps {
  /** Rows from GET /costs/status — the component picks out the ones to explain. */
  statuses: CostAccountStatus[];
  /**
   * Desktop routes external links through the shell instead of the renderer.
   * Omit in the browser and the anchor's `target="_blank"` is used as-is.
   */
  onOpenExternal?: ((url: string) => void) | undefined;
}

/**
 * Explains why cost data is missing — or where it came from.
 *
 * Three states get their own notice, because each otherwise renders as a graph
 * with nothing to act on, or worse, a graph that looks fine and isn't:
 *
 *  - Collection is failing. Runs daily and backs off, so a misconfigured
 *    provider (GCP without its BigQuery billing export, an expired billing
 *    scope) stays broken silently. When the plugin threw a `CostSetupError`
 *    the stored help link deep-links to the page that fixes it.
 *  - Collection succeeds and returns nothing. A correctly configured export
 *    that hasn't produced its first rows yet is healthy in every stored
 *    field, so without saying so the blank graph reads as a bug.
 *  - Spend is estimated rather than billed. Some providers publish no billing
 *    API at all, so their amounts are inventory priced against a rate card.
 *    That graph looks exactly like a collected one, which is the problem: the
 *    number is systematically not the invoice, and the reader has to be told
 *    before they reconcile it rather than after.
 *
 * Renders nothing when every cost-capable account is collecting real data.
 */
export function CostCollectionNotice({ statuses, onOpenExternal }: CostCollectionNoticeProps) {
  const failing = failingCostAccounts(statuses);
  const empty = emptyCostAccounts(statuses);
  const estimated = estimatedCostAccounts(statuses);
  if (failing.length === 0 && empty.length === 0 && estimated.length === 0) return null;

  return (
    <>
      {failing.length > 0 && (
        <div
          role="status"
          className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
        >
          <p className="font-medium text-warning">
            {failing.length === 1
              ? `Cost collection is failing for ${failing[0]!.displayName}`
              : `Cost collection is failing for ${failing.length} accounts`}
          </p>
          <ul className="mt-1 space-y-1.5">
            {failing.map((s) => (
              <li key={s.accountId} className="text-on-surface-secondary">
                {failing.length > 1 && (
                  <span className="text-on-surface-muted">{s.displayName} — </span>
                )}
                {s.costPollError!.message}
                {s.costPollError!.helpLink && (
                  <>
                    {" "}
                    <a
                      href={s.costPollError!.helpLink!.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={
                        onOpenExternal
                          ? (e) => {
                              e.preventDefault();
                              onOpenExternal(s.costPollError!.helpLink!.url);
                            }
                          : undefined
                      }
                      className="inline-flex items-center gap-1 text-info hover:text-info-strong whitespace-nowrap"
                    >
                      {s.costPollError!.helpLink!.label}
                      <span aria-hidden="true">↗</span>
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-on-surface-faint">
            Collection retries on its own — fix the cause and the next run backfills the gap.
          </p>
        </div>
      )}

      {empty.length > 0 && (
        <div
          role="status"
          className="mb-4 rounded-xl border border-border bg-surface-overlay px-4 py-3 text-sm"
        >
          <p className="font-medium text-on-surface">
            {empty.length === 1
              ? `No spend data yet for ${empty[0]!.displayName}`
              : `No spend data yet for ${empty.length} accounts`}
          </p>
          {empty.length > 1 && (
            <ul className="mt-1 space-y-1.5">
              {empty.map((s) => (
                <li key={s.accountId} className="text-on-surface-secondary">
                  {s.displayName}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1.5 text-xs text-on-surface-faint">
            Collection ran without error — the provider just hasn&apos;t reported any spend. A
            billing export enabled in the last day or two often has no rows to return yet.
          </p>
        </div>
      )}

      {estimated.length > 0 && (
        <div
          role="status"
          className="mb-4 rounded-xl border border-border bg-surface-overlay px-4 py-3 text-sm"
        >
          <p className="font-medium text-on-surface">
            {estimated.length === 1
              ? `Spend for ${estimated[0]!.displayName} is estimated`
              : `Spend for ${estimated.length} accounts is estimated`}
          </p>
          {estimated.length > 1 && (
            <ul className="mt-1 space-y-1.5">
              {estimated.map((s) => (
                <li key={s.accountId} className="text-on-surface-secondary">
                  {s.displayName}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1.5 text-xs text-on-surface-faint">
            {estimated.length === 1 ? "This provider publishes" : "These providers publish"} no
            billing API, so the amounts are what your current resources list for rather than what
            you were billed. Expect it to run low: anything deleted part-way through the period is
            no longer there to price, every rate is list rather than negotiated, and credits, tax
            and refunds never appear.
          </p>
        </div>
      )}
    </>
  );
}
