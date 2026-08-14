import { useCallback, useEffect, useRef, useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  formatMoney,
  formatTicketRef,
  type ResourceOwnerAnnotation,
} from "@infrawrench/client-core";
import { FileIssueButton } from "../issue-filing/FileIssueButton.js";
import { useDataString } from "../i18n/data-strings.js";
import type { OrphanedResource, OrphanListResponse, OrphansClient } from "./types.js";

/**
 * The owner of a flagged resource, or an explicit "Unowned".
 *
 * Unowned is rendered as a real value rather than a blank cell, because it is
 * the finding: a resource nobody has claimed is the one this list can do least
 * about. A free-text owner is shown in the same place but without the ticket
 * link's implication of a person to page — `isLabel` is what distinguishes
 * "Sam Reyes" from "Platform team", and only the former gets alerts.
 */
function OwnerCell({ owner }: { owner: ResourceOwnerAnnotation | null }) {
  const gt = useGT();
  if (!owner) {
    return (
      <span className="rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-on-surface-faint">
        {gt("Unowned")}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <span className="text-on-surface">{owner.displayName}</span>
      {owner.isLabel && (
        <span
          className="text-xs text-on-surface-faint"
          title={gt("A team name, not an Infrawrench member — alerts can't be routed to it.")}
        >
          {gt("team")}
        </span>
      )}
      {owner.ticketUrl && (
        <a
          href={owner.ticketUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-xs text-on-surface-tertiary underline hover:text-on-surface"
        >
          {formatTicketRef(owner.ticketUrl)}
        </a>
      )}
    </span>
  );
}

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
  const gt = useGT();
  const gtData = useDataString();
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
  // Ownership is a cloud record too. Local mode reports every row unowned
  // because it has no ownership data — which is not the same claim, so the
  // column comes off there rather than labelling everything "Unowned".
  const showOwner = data !== null && data.costBasis !== "unavailable";

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">{gt("Potential savings")}</h2>
          <p className="mt-1 text-xs text-on-surface-secondary">
            {gt(
              "Resources that look orphaned or idle, based on the state your accounts last synced.",
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="shrink-0 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
        >
          {gt("Refresh")}
        </button>
      </div>

      {error !== null && (
        <div role="alert" className="text-sm text-danger">
          {gt("Couldn't load potential savings — {error}", { error })}{" "}
          <button type="button" onClick={() => void refresh()} className="underline">
            {gt("Retry")}
          </button>
        </div>
      )}
      {data === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Scanning synced resources…")}
        </p>
      )}
      {data !== null && data.accounts.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          {gt(
            "Nothing looks wasted right now. Resources are flagged when a provider plugin's heuristic matches — unattached volumes, unassigned IPs — so an empty list is the good outcome.",
          )}
          {!showCost && (
            <>
              {" "}
              {gt(
                "This scan covers the resources stored in the local workspace; sign in to classify everything your accounts sync.",
              )}
            </>
          )}
        </p>
      )}

      {data?.accounts.map((group) => (
        <div key={group.accountId} className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-medium text-on-surface">
              {group.accountName}
              <span className="ml-2 font-normal text-on-surface-tertiary">
                {gtData(group.pluginName)}
              </span>
            </h3>
            <span className="text-xs text-on-surface-faint">
              {gt("{count} flagged", { count: group.resources.length })}
            </span>
          </div>
          <div className="border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <tbody>
                {group.resources.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-border last:border-b-0 hover:bg-surface-raised"
                  >
                    <td className="px-4 py-2.5 whitespace-nowrap font-medium text-on-surface">
                      {/* The name is the navigation control, not the row — a
                          <tr> has no role a screen reader announces as
                          activatable. */}
                      {onOpenResource ? (
                        <button
                          type="button"
                          onClick={() => onOpenResource(r, group.accountId)}
                          className="cursor-pointer text-left font-medium text-on-surface hover:underline"
                        >
                          {r.displayName}
                        </button>
                      ) : (
                        r.displayName
                      )}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span className="rounded-full border border-border px-2 py-0.5 text-xs text-on-surface-tertiary">
                        {gtData(r.resourceTypeName)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 w-full text-on-surface-secondary">
                      {gtData(r.reason)}
                    </td>
                    {showOwner && (
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <OwnerCell owner={r.owner} />
                      </td>
                    )}
                    {showCost && (
                      <td className="px-4 py-2.5 whitespace-nowrap text-right text-on-surface">
                        {r.cost ? (
                          <>
                            {formatMoney(r.cost.amount, r.cost.currency)}
                            <span className="ml-1 text-xs text-on-surface-faint">
                              {gt("/ {days}d", { days: data.costWindowDays })}
                            </span>
                          </>
                        ) : (
                          <span className="text-on-surface-faint">—</span>
                        )}
                      </td>
                    )}
                    <td className="px-3 py-2.5 whitespace-nowrap text-right">
                      <FileIssueButton
                        sourceKind="orphan"
                        sourceId={r.id}
                        draft={{
                          title: gt("{name} ({type}) looks orphaned", {
                            name: r.displayName,
                            type: gtData(r.resourceTypeName),
                          }),
                          details: [
                            { label: gt("Resource"), value: r.displayName },
                            { label: gt("Type"), value: gtData(r.resourceTypeName) },
                            { label: gt("Provider"), value: gtData(group.pluginName) },
                            { label: gt("Account"), value: group.accountName },
                            { label: gt("Provider id"), value: r.externalId },
                            {
                              label: gt("Spend / {days}d", { days: data.costWindowDays }),
                              value: r.cost
                                ? formatMoney(r.cost.amount, r.cost.currency)
                                : undefined,
                            },
                            { label: gt("Last synced"), value: r.lastSyncedAt },
                          ],
                          note: r.reason,
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {data !== null &&
        data.accounts.length > 0 &&
        showOwner &&
        data.unownedCount > 0 &&
        (data.unownedCount === 1 ? (
          <T>
            <p className="text-xs text-on-surface-secondary">
              <strong className="font-medium text-on-surface">
                <Var>{data.unownedCount}</Var> of <Var>{data.totalCount}</Var>
              </strong>{" "}
              has no recorded owner — nobody to ask before deleting, and nobody an alert can
              reach. Open a resource and set an owner on its{" "}
              <span className="text-on-surface">Ownership</span> tab.
            </p>
          </T>
        ) : (
          <T>
            <p className="text-xs text-on-surface-secondary">
              <strong className="font-medium text-on-surface">
                <Var>{data.unownedCount}</Var> of <Var>{data.totalCount}</Var>
              </strong>{" "}
              have no recorded owner — nobody to ask before deleting, and nobody an alert can
              reach. Open a resource and set an owner on its{" "}
              <span className="text-on-surface">Ownership</span> tab.
            </p>
          </T>
        ))}

      {data !== null && data.accounts.length > 0 && (
        <p className="text-xs text-on-surface-faint">
          {showCost ? (
            <T>
              <>
                Cost figures are best-effort, matched from collected per-resource billing rows
                over the last <Var>{data.costWindowDays}</Var> days; most providers don&apos;t
                report cost at resource granularity.
              </>
            </T>
          ) : (
            <T>
              <>
                No cost figures here: spend is collected by Infrawrench Cloud, and this workspace
                is local. The flags themselves never depend on billing data.
              </>
            </T>
          )}{" "}
          {gt("Confirm a resource really is unused before deleting it.")}
        </p>
      )}
    </section>
  );
}
