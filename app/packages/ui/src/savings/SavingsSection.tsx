import { useCallback, useEffect, useRef, useState } from "react";
import { formatMoney } from "@infrawrench/client-core";
import type { OrphanedResource, OrphanListResponse, OrphansClient } from "./types.js";

export interface SavingsSectionProps {
  /**
   * Org-scoped data access. The Costs panel that hosts this section is mounted
   * with `key={orgId}`, so an org switch remounts it — that is what clears the
   * previous org's rows, rather than an effect resetting every state value by
   * hand.
   */
  client: OrphansClient;
  /**
   * Navigate to a flagged resource's detail view. `accountId` comes from the
   * resource's account group rather than the resource id, which encodes
   * `pluginId:accountId:externalId` and so can't be split on naively.
   */
  onOpenResource?: ((resource: OrphanedResource, accountId: string) => void) | undefined;
}

/**
 * "Potential savings" section of the Costs panel: resources the plugins' orphan
 * heuristics flagged as likely wasted — unattached volumes, unassigned IPs —
 * grouped by account, each with the plugin's reason and, where the org collects
 * per-resource cost rows, trailing spend.
 *
 * This lives under the month-to-date chart and budgets rather than on a page of
 * its own: it answers a question the reader already has open ("what is this org
 * spending, and what of it is wasted"), and a separate tab made them go looking
 * for it.
 */
export function SavingsSection({ client, onOpenResource }: SavingsSectionProps) {
  const [data, setData] = useState<OrphanListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped per request so a slow response can't overwrite the result of a
  // later refresh that already landed.
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
    void refresh();
  }, [refresh]);

  // Local mode has no collected billing rows, so every `cost` is null there.
  // A column of dashes in a headerless table reads as "this costs nothing";
  // drop it instead and say why below the list.
  const showCost = data !== null && data.costBasis !== "unavailable";

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">Potential savings</h2>
          <p className="mt-1 text-xs text-on-surface-secondary">
            Resources that look orphaned or idle, based on the state your accounts last synced.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="shrink-0 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
        >
          Refresh
        </button>
      </div>

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
          {!showCost && (
            <>
              {" "}
              This scan covers the resources stored in the local workspace; sign in to classify
              everything your accounts sync.
            </>
          )}
        </p>
      )}

      {data?.accounts.map((group) => (
        <div key={group.accountId} className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-medium text-on-surface">
              {group.accountName}
              <span className="ml-2 font-normal text-on-surface-tertiary">{group.pluginName}</span>
            </h3>
            <span className="text-xs text-on-surface-faint">{group.resources.length} flagged</span>
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
                    onClick={onOpenResource ? () => onOpenResource(r, group.accountId) : undefined}
                    onKeyDown={
                      onOpenResource
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onOpenResource(r, group.accountId);
                            }
                          }
                        : undefined
                    }
                    tabIndex={onOpenResource ? 0 : undefined}
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
                    {showCost && (
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
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {data !== null && data.accounts.length > 0 && (
        <p className="text-xs text-on-surface-faint">
          {showCost ? (
            <>
              Cost figures are best-effort, matched from collected per-resource billing rows over
              the last {data.costWindowDays} days; most providers don&apos;t report cost at resource
              granularity.
            </>
          ) : (
            <>
              No cost figures here: spend is collected by Infrawrench Cloud, and this workspace is
              local. The flags themselves never depend on billing data.
            </>
          )}{" "}
          Confirm a resource really is unused before deleting it.
        </p>
      )}
    </section>
  );
}
