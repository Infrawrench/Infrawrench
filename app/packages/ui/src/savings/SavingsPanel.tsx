import { useCallback, useEffect, useRef, useState } from "react";
import { formatMoney } from "@infrawrench/client-core";
import type { OrphanedResource, OrphanListResponse, OrphansClient } from "./types.js";

export interface SavingsPanelProps {
  client: OrphansClient;
  /**
   * Navigate to a flagged resource's detail view. `accountId` comes from the
   * resource's account group rather than the resource id, which encodes
   * `pluginId:accountId:externalId` and so can't be split on naively.
   */
  onOpenResource?: ((resource: OrphanedResource, accountId: string) => void) | undefined;
}

/**
 * Org-level "Potential savings" page: resources the plugins' orphan heuristics
 * flagged as likely wasted — unattached volumes, unassigned IPs — grouped by
 * account, each with the plugin's reason and, where the org collects
 * per-resource cost rows, trailing spend.
 */
export function SavingsPanel({ client, onOpenResource }: SavingsPanelProps) {
  const [data, setData] = useState<OrphanListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped per request so a response that arrives after an org switch or a
  // later refresh can't overwrite newer state with another org's resources.
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    setError(null);
    try {
      const next = await client.listOrphans();
      if (seq === requestSeq.current) setData(next);
    } catch (e) {
      if (seq === requestSeq.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    // A new client means a new org: drop the previous org's rows immediately
    // rather than leaving them on screen until the refetch lands.
    requestSeq.current++;
    setData(null);
    setError(null);
    void refresh();
  }, [refresh]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6 flex flex-col gap-6">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-on-surface">Potential savings</h1>
            <p className="mt-1 text-sm text-on-surface-secondary">
              Resources that look orphaned or idle, based on the state your accounts last synced —
              no extra provider calls.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface-secondary hover:bg-surface-raised"
          >
            Refresh
          </button>
        </header>

        {error !== null && (
          <div role="alert" className="text-sm text-red-500">
            Couldn&apos;t load potential savings — {error}{" "}
            <button type="button" onClick={() => void refresh()} className="underline">
              Retry
            </button>
          </div>
        )}
        {data === null && error === null && (
          <p role="status" className="text-sm text-on-surface-faint">
            Scanning synced resources…
          </p>
        )}
        {data !== null && data.accounts.length === 0 && (
          <p className="text-sm text-on-surface-faint">
            Nothing looks wasted right now. Resources are flagged when a provider plugin&apos;s
            heuristic matches — unattached volumes, unassigned IPs — so an empty list is the good
            outcome.
          </p>
        )}

        {data?.accounts.map((group) => (
          <section key={group.accountId} className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold text-on-surface">
                {group.accountName}
                <span className="ml-2 font-normal text-on-surface-tertiary">
                  {group.pluginName}
                </span>
              </h2>
              <span className="text-xs text-on-surface-faint">
                {group.resources.length} flagged
              </span>
            </div>
            <div className="border border-border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <tbody>
                  {group.resources.map((r) => (
                    <tr
                      key={r.id}
                      className={`border-b border-border last:border-b-0 ${
                        onOpenResource ? "cursor-pointer hover:bg-surface-raised" : ""
                      }`}
                      onClick={
                        onOpenResource ? () => onOpenResource(r, group.accountId) : undefined
                      }
                    >
                      <td className="px-4 py-2.5 whitespace-nowrap font-medium text-on-surface">
                        {r.displayName}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-on-surface-tertiary">
                          {r.resourceTypeName}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 w-full text-on-surface-secondary">{r.reason}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-right text-on-surface">
                        {r.cost ? (
                          <>
                            {formatMoney(r.cost.amount, r.cost.currency)}
                            <span className="ml-1 text-xs text-on-surface-faint">
                              / {data.costWindowDays}d
                            </span>
                          </>
                        ) : (
                          <span className="text-on-surface-faint">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}

        {data !== null && data.accounts.length > 0 && (
          <p className="text-xs text-on-surface-faint">
            Cost figures are best-effort, matched from collected per-resource billing rows over the
            last {data.costWindowDays} days; most providers don&apos;t report cost at resource
            granularity. Confirm a resource really is unused before deleting it.
          </p>
        )}
      </div>
    </div>
  );
}
