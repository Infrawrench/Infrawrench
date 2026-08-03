import { useCallback, useEffect, useRef, useState } from "react";
import { formatMoney } from "@infrawrench/client-core";
import type { OversizedResource, RightsizingClient, RightsizingListResponse } from "./types.js";

export interface OversizedSectionProps {
  /** Org-scoped data access; the hosting Costs panel remounts per org. */
  client: RightsizingClient;
  /** Navigate to a flagged resource's detail view. */
  onOpenResource?: ((resource: OversizedResource, accountId: string) => void) | undefined;
}

/** GB with one decimal only when it isn't whole — "4 GB", "0.5 GB". */
function formatGb(memoryMb: number): string {
  const gb = memoryMb / 1024;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

function sizeCaption(size: OversizedResource["currentSize"]): string {
  return `${size.label} (${size.vcpus} vCPU / ${formatGb(size.memoryMb)})`;
}

/**
 * Build the confirm-dialog text quoting exactly what will be applied. The
 * apply path is the ordinary resource update, so the provider's own
 * constraints (stopped-only resizes etc.) surface as errors on this row.
 */
export function describeResizeConfirm(r: OversizedResource): string {
  const lines = [
    `Resize ${r.displayName} from ${sizeCaption(r.currentSize)} to ${sizeCaption(r.recommendedSize)}?`,
    "",
    `p95 CPU over the last 14 days: ${r.cpuP95}% (≈${r.projectedCpuP95}% on the new size).`,
    r.memoryMeasured && r.memoryP95 !== null
      ? `p95 memory: ${r.memoryP95}%.`
      : "Memory usage is not measured for this resource — confirm the smaller size's RAM fits before applying.",
    r.monthlySaving !== null
      ? `Estimated saving: ${formatMoney(r.monthlySaving, r.currency)}/mo.`
      : "No price could be quoted for this change.",
  ];
  if (r.resizeNote) lines.push("", r.resizeNote);
  return lines.join("\n");
}

/**
 * "Oversized" section of the Costs panel: resources whose stored p95
 * utilisation sits well under their current size, with the cheapest catalog
 * size that still clears headroom and a one-click apply through the ordinary
 * resource-update path (change freezes and tag policy answer there; the row
 * shows whatever 4xx the server returns rather than pretending).
 */
export function OversizedSection({ client, onOpenResource }: OversizedSectionProps) {
  const [data, setData] = useState<RightsizingListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-row in-flight set — one slow resize must not re-enable (or disable)
  // any other row's Apply button.
  const [applying, setApplying] = useState<ReadonlySet<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  /** resource id → applied size *label* (what the row displays). */
  const [applied, setApplied] = useState<Record<string, string>>({});
  const requestSeq = useRef(0);

  const refresh = useCallback(
    async (force: boolean) => {
      const seq = ++requestSeq.current;
      setError(null);
      try {
        const next = await client.listRightsizing(force);
        if (seq === requestSeq.current) setData(next);
      } catch (e) {
        if (seq === requestSeq.current) setError(e instanceof Error ? e.message : String(e));
      }
    },
    [client],
  );

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  const apply = useCallback(
    async (resource: OversizedResource, accountId: string) => {
      if (!window.confirm(describeResizeConfirm(resource))) return;
      setApplying((prev) => new Set(prev).add(resource.id));
      setRowErrors((prev) => {
        const { [resource.id]: _dropped, ...rest } = prev;
        return rest;
      });
      try {
        await client.applyResize(resource, accountId);
        setApplied((prev) => ({ ...prev, [resource.id]: resource.recommendedSize.label }));
      } catch (e) {
        // Change-freeze 423s and tag-policy 422s land here with the server's
        // own explanation — show it verbatim, offer nothing else.
        setRowErrors((prev) => ({
          ...prev,
          [resource.id]: e instanceof Error ? e.message : String(e),
        }));
      } finally {
        setApplying((prev) => {
          const next = new Set(prev);
          next.delete(resource.id);
          return next;
        });
      }
    },
    [client],
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">Oversized</h2>
          <p className="mt-1 text-xs text-on-surface-secondary">
            Machines whose p95 utilisation over the last {data?.windowDays ?? 14} days sits well
            under their size, with the smallest size that still leaves headroom.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh(true)}
          className="shrink-0 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
        >
          Refresh
        </button>
      </div>

      {error !== null && (
        <div role="alert" className="text-sm text-red-500">
          Couldn&apos;t compute right-sizing — {error}{" "}
          <button type="button" onClick={() => void refresh(true)} className="underline">
            Retry
          </button>
        </div>
      )}
      {data === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          Reading stored metrics and size catalogs…
        </p>
      )}
      {data !== null && data.accounts.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          Nothing looks oversized. A machine is flagged when two weeks of stored metrics put its p95
          CPU (and memory, where measured) well under its size — so an empty list means your fleet
          fits, or the metrics to prove otherwise aren&apos;t collected yet (metrics are stored for
          resources pinned to a dashboard).
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
                  <tr key={r.id} className="border-b border-border last:border-b-0 align-top">
                    <td className="px-4 py-2.5 whitespace-nowrap font-medium text-on-surface">
                      {onOpenResource ? (
                        <button
                          type="button"
                          className="hover:underline"
                          onClick={() => onOpenResource(r, group.accountId)}
                        >
                          {r.displayName}
                        </button>
                      ) : (
                        r.displayName
                      )}
                      <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-xs font-normal text-on-surface-tertiary">
                        {r.resourceTypeName}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-on-surface-secondary">
                      {r.currentSize.label}
                      <span className="mx-1 text-on-surface-faint">→</span>
                      <span className="text-on-surface">{r.recommendedSize.label}</span>
                    </td>
                    <td className="px-3 py-2.5 w-full text-on-surface-secondary">
                      p95 CPU {r.cpuP95}%
                      {r.memoryMeasured && r.memoryP95 !== null ? (
                        <> · p95 memory {r.memoryP95}%</>
                      ) : (
                        <> · memory not measured</>
                      )}
                      {rowErrors[r.id] && (
                        <div role="alert" className="mt-1 text-xs text-red-500">
                          {rowErrors[r.id]}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-right text-on-surface">
                      {r.monthlySaving !== null ? (
                        <>
                          {formatMoney(r.monthlySaving, r.currency)}
                          <span className="ml-1 text-xs text-on-surface-faint">/mo</span>
                        </>
                      ) : (
                        <span className="text-on-surface-faint">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-right">
                      {applied[r.id] ? (
                        <span className="text-xs text-on-surface-faint">
                          Applied {applied[r.id]}
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={applying.has(r.id)}
                          onClick={() => void apply(r, group.accountId)}
                          className="rounded-lg border border-border bg-surface-raised px-3 py-1 text-xs text-on-surface hover:border-border-strong disabled:opacity-50"
                        >
                          {applying.has(r.id) ? "Applying…" : "Apply resize"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {data !== null && data.accounts.length > 0 && (
        <p className="text-xs text-on-surface-faint">
          Savings are quoted from each provider&apos;s live size catalog. Applying a resize goes
          through the normal resource update — change freezes and audit logging apply — and most
          providers require the machine to be stopped first (the row says so before you confirm).
        </p>
      )}
    </section>
  );
}
