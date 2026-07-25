import { failingCostAccounts, type CostAccountStatus } from "@infrawrench/client-core";

export interface CostCollectionNoticeProps {
  /** Rows from GET /costs/status — the component picks out the failing ones. */
  statuses: CostAccountStatus[];
  /**
   * Desktop routes external links through the shell instead of the renderer.
   * Omit in the browser and the anchor's `target="_blank"` is used as-is.
   */
  onOpenExternal?: ((url: string) => void) | undefined;
}

/**
 * Explains why cost data is missing for an account.
 *
 * Cost collection runs daily in the background and backs off on failure, so a
 * misconfigured provider (GCP without its BigQuery billing export, an expired
 * billing scope) otherwise shows up as a permanently empty graph with no clue
 * attached. When the plugin threw a `CostSetupError` the stored help link
 * deep-links to the provider page that fixes it.
 *
 * Renders nothing when every cost-capable account is collecting cleanly.
 */
export function CostCollectionNotice({ statuses, onOpenExternal }: CostCollectionNoticeProps) {
  const failing = failingCostAccounts(statuses);
  if (failing.length === 0) return null;

  return (
    <div
      role="status"
      className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
    >
      <p className="font-medium text-amber-300">
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
                  className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 whitespace-nowrap"
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
  );
}
