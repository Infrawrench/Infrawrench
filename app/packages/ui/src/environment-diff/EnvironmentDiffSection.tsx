import { useCallback, useEffect, useMemo, useState } from "react";
import { formatChangeValue } from "@infrawrench/client-core";
import type {
  EnvironmentDiffAccount,
  EnvironmentDiffClient,
  EnvironmentDiffEntry,
  EnvironmentDiffResponse,
  EnvironmentDiffResourceRef,
  EnvironmentDiffResourceTarget,
  EnvironmentDiffStatus,
} from "./types.js";

export interface EnvironmentDiffSectionProps {
  /** Data access; see `EnvironmentDiffClient`. */
  client: EnvironmentDiffClient;
  /** Account preselected as the baseline, from the tab target / URL. */
  initialA?: string | undefined;
  /** Account preselected as the comparison. */
  initialB?: string | undefined;
  /**
   * Called when the user picks a different pair, so the host can record it on
   * the workspace tab and in the URL. Both ids, or nothing while incomplete.
   */
  onSelectionChange?: ((selection: { a?: string; b?: string }) => void) | undefined;
  /** Jump to a resource's detail view. Omitted, names are plain text. */
  onOpenResource?: ((target: EnvironmentDiffResourceTarget) => void) | undefined;
}

const STATUS_LABELS: Record<EnvironmentDiffStatus, string> = {
  "only-in-a": "Only in A",
  "only-in-b": "Only in B",
  changed: "Differs",
};

/** Pill tones per status, matching the PostureSection translucent-badge recipe. */
const STATUS_BADGE_CLASSES: Record<EnvironmentDiffStatus, string> = {
  "only-in-a": "bg-amber-500/10 text-amber-400",
  "only-in-b": "bg-sky-500/10 text-sky-400",
  changed: "bg-violet-500/10 text-violet-400",
};

interface TypeGroup {
  resourceTypeId: string;
  resourceTypeName: string;
  entries: EnvironmentDiffEntry[];
}

/** Entries arrive sorted by type, so insertion order already groups them. */
function groupByType(entries: EnvironmentDiffEntry[]): TypeGroup[] {
  const groups = new Map<string, TypeGroup>();
  for (const entry of entries) {
    let group = groups.get(entry.resourceTypeId);
    if (!group) {
      group = {
        resourceTypeId: entry.resourceTypeId,
        resourceTypeName: entry.resourceTypeName,
        entries: [],
      };
      groups.set(entry.resourceTypeId, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
}

function signed(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
}

/**
 * Environment diff: two accounts of the same provider compared side by side —
 * resource types present in one and not the other, per-type count deltas, and
 * the fields on which two corresponding resources disagree.
 *
 * Shared by the web and desktop Env diff screens; `infrawrench diff` prints
 * the same comparison as text. The panel never talks to a network — the host
 * injects a client (see `EnvironmentDiffClient`).
 */
export function EnvironmentDiffSection({
  client,
  initialA,
  initialB,
  onSelectionChange,
  onOpenResource,
}: EnvironmentDiffSectionProps) {
  const [accounts, setAccounts] = useState<EnvironmentDiffAccount[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [a, setA] = useState(initialA ?? "");
  const [b, setB] = useState(initialB ?? "");
  const [includeIdentityFields, setIncludeIdentityFields] = useState(false);
  const [data, setData] = useState<EnvironmentDiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    client
      .listAccounts()
      .then((rows) => {
        if (!cancelled) setAccounts(rows);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setAccountsError(e instanceof Error ? e.message : "Failed to load the accounts");
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Side B can only be an account of side A's provider — a Droplet has no
  // counterpart in an AWS account, so the server refuses the pair outright.
  const pluginOfA = accounts?.find((x) => x.id === a)?.pluginId;
  const optionsB = useMemo(
    () => (accounts ?? []).filter((x) => x.id !== a && (!pluginOfA || x.pluginId === pluginOfA)),
    [accounts, a, pluginOfA],
  );

  // Reported from the change handlers rather than an effect on [a, b]: the
  // host records this on the workspace tab and in the URL, and an effect would
  // also fire on mount, echoing the tab's own initial values straight back.
  const select = useCallback(
    (next: { a: string; b: string }) => {
      setA(next.a);
      setB(next.b);
      onSelectionChange?.({ ...(next.a ? { a: next.a } : {}), ...(next.b ? { b: next.b } : {}) });
    },
    [onSelectionChange],
  );

  useEffect(() => {
    if (!a || !b) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    client
      .compare({ a, b, includeIdentityFields })
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to compare the two accounts");
        // A failed comparison of a *different* pair must not leave the previous
        // pair's diff on screen labelled as this one.
        setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, a, b, includeIdentityFields, reloadKey]);

  const groups = useMemo(() => (data ? groupByType(data.entries) : []), [data]);

  const nameOf = (id: string) => accounts?.find((x) => x.id === id)?.displayName ?? id;

  return (
    <div className="flex-1 overflow-auto p-6">
      <h1 className="text-xl font-semibold mb-1">Environment diff</h1>
      <p className="text-sm text-on-surface-muted mb-6">
        Two accounts of the same provider, compared over the state they last synced — what exists in
        one and not the other, how the counts differ, and where corresponding resources disagree on
        a setting. The answer to &ldquo;why does staging work and prod doesn&apos;t&rdquo;.
      </p>

      <div className="flex flex-wrap items-end gap-3 mb-6">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-on-surface-faint">Baseline (A)</span>
          <select
            value={a}
            onChange={(e) => {
              const nextA = e.target.value;
              // Switching the baseline to another provider strands the B
              // selection; drop it rather than send a doomed request.
              const stillComparable = accounts?.some(
                (x) =>
                  x.id === b &&
                  x.id !== nextA &&
                  x.pluginId === accounts.find((y) => y.id === nextA)?.pluginId,
              );
              select({ a: nextA, b: stillComparable ? b : "" });
            }}
            className="rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-sm min-w-48"
          >
            <option value="">Choose an account…</option>
            {(accounts ?? []).map((account) => (
              <option key={account.id} value={account.id}>
                {account.displayName}
              </option>
            ))}
          </select>
        </label>
        <span className="pb-2 text-on-surface-faint text-sm">vs</span>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-on-surface-faint">Compared (B)</span>
          <select
            value={b}
            onChange={(e) => select({ a, b: e.target.value })}
            disabled={!a}
            className="rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-sm min-w-48 disabled:opacity-50"
          >
            <option value="">Choose an account…</option>
            {optionsB.map((account) => (
              <option key={account.id} value={account.id}>
                {account.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-xs text-on-surface-tertiary">
          <input
            type="checkbox"
            checked={includeIdentityFields}
            onChange={(e) => setIncludeIdentityFields(e.target.checked)}
          />
          Show ids, addresses &amp; timestamps
        </label>
      </div>

      {accountsError != null && (
        <p role="alert" className="mb-4 text-sm text-red-500">
          Couldn&apos;t load the accounts — {accountsError}
        </p>
      )}

      {(!a || !b) && accountsError == null && (
        <p className="text-sm text-on-surface-faint">
          {accounts !== null && accounts.length < 2
            ? "An environment diff needs two accounts of the same provider. Add a second account to compare."
            : "Pick two accounts of the same provider to compare."}
        </p>
      )}

      {error != null && (
        <div role="alert" className="text-sm text-red-500">
          {error}{" "}
          <button type="button" onClick={retry} className="underline">
            Retry
          </button>
        </div>
      )}

      {loading && data === null && error == null && a && b && (
        <p role="status" className="text-sm text-on-surface-faint">
          Comparing…
        </p>
      )}

      {data !== null && (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-5">
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-amber-500/10 text-amber-400">
              <span className="tabular-nums">{data.totals.onlyInA}</span> only in{" "}
              {nameOf(data.a.accountId)}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-sky-500/10 text-sky-400">
              <span className="tabular-nums">{data.totals.onlyInB}</span> only in{" "}
              {nameOf(data.b.accountId)}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-violet-500/10 text-violet-400">
              <span className="tabular-nums">{data.totals.changed}</span> differ
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-surface-overlay text-on-surface-tertiary">
              <span className="tabular-nums">{data.totals.identical}</span> identical
            </span>
          </div>

          {data.unavailableTypes.length > 0 && (
            <p role="alert" className="mb-4 text-xs text-amber-400">
              Couldn&apos;t list {data.unavailableTypes.map((t) => t.resourceTypeName).join(", ")} —
              excluded from the comparison rather than reported as missing. (
              {data.unavailableTypes[0]?.message})
            </p>
          )}

          <div className="border border-border rounded-xl overflow-hidden mb-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-on-surface-faint">
                  <th className="px-4 py-2 text-left font-normal">Resource type</th>
                  <th className="px-3 py-2 text-right font-normal">{data.a.accountName}</th>
                  <th className="px-3 py-2 text-right font-normal">{data.b.accountName}</th>
                  <th className="px-3 py-2 text-right font-normal">Delta</th>
                  <th className="px-4 py-2 text-right font-normal">Differences</th>
                </tr>
              </thead>
              <tbody>
                {data.types.map((type) => (
                  <tr key={type.resourceTypeId} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-2 align-top text-on-surface">
                      {type.resourceTypeName}
                      {type.missingFrom && (
                        <span className="ml-2 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-400">
                          missing from{" "}
                          {type.missingFrom === "a" ? data.a.accountName : data.b.accountName}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-on-surface-secondary">
                      {type.countA}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-on-surface-secondary">
                      {type.countB}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        type.delta === 0 ? "text-on-surface-faint" : "text-on-surface"
                      }`}
                    >
                      {signed(type.delta)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-on-surface-tertiary">
                      {type.onlyInA + type.onlyInB + type.changed}
                    </td>
                  </tr>
                ))}
                {data.types.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-3 text-on-surface-faint">
                      Neither account has any synced resources.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {data.entries.length === 0 ? (
            <p className="text-sm text-on-surface-faint">
              The two inventories match. Every resource in {data.a.accountName} has a counterpart in{" "}
              {data.b.accountName} with the same settings.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {groups.map((group) => (
                <div key={group.resourceTypeId} className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="text-sm font-medium text-on-surface">
                      {group.resourceTypeName}
                    </h2>
                    <span className="text-xs text-on-surface-faint">
                      {group.entries.length} difference{group.entries.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="border border-border rounded-xl overflow-hidden">
                    <table className="w-full text-sm">
                      <tbody>
                        {group.entries.map((entry) => (
                          <tr key={entry.key} className="border-b border-border last:border-b-0">
                            <td className="px-4 py-2.5 whitespace-nowrap align-top">
                              <span
                                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_BADGE_CLASSES[entry.status]}`}
                              >
                                {STATUS_LABELS[entry.status]}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 align-top">
                              <ResourceName
                                resource={entry.a}
                                pluginId={data.pluginId}
                                resourceTypeId={entry.resourceTypeId}
                                fallback={data.a.accountName}
                                onOpenResource={onOpenResource}
                              />
                            </td>
                            <td className="px-3 py-2.5 align-top">
                              <ResourceName
                                resource={entry.b}
                                pluginId={data.pluginId}
                                resourceTypeId={entry.resourceTypeId}
                                fallback={data.b.accountName}
                                onOpenResource={onOpenResource}
                              />
                            </td>
                            <td className="px-4 py-2.5 w-full align-top">
                              {entry.changes.length === 0 ? (
                                <span className="text-xs text-on-surface-faint">
                                  {entry.status === "only-in-a"
                                    ? `No counterpart in ${data.b.accountName}`
                                    : `No counterpart in ${data.a.accountName}`}
                                </span>
                              ) : (
                                <div className="flex flex-col gap-1">
                                  {entry.changes.map((change) => (
                                    <div key={change.field} className="text-xs">
                                      <span className="font-medium text-on-surface">
                                        {change.field}
                                      </span>
                                      <span className="ml-2 text-amber-400">
                                        {formatChangeValue(change.a)}
                                      </span>
                                      <span className="mx-1.5 text-on-surface-faint">→</span>
                                      <span className="text-sky-400">
                                        {formatChangeValue(change.b)}
                                      </span>
                                    </div>
                                  ))}
                                  {entry.suppressedCount > 0 && (
                                    <span className="text-[11px] text-on-surface-faint">
                                      + {entry.suppressedCount} id/address/timestamp difference
                                      {entry.suppressedCount === 1 ? "" : "s"} hidden
                                    </span>
                                  )}
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}

          <p className="mt-4 text-xs text-on-surface-faint">
            Resources are paired by type and by name with environment words removed, so{" "}
            <code>api-staging</code> lines up with <code>api-prod</code>.{" "}
            {data.includeIdentityFields
              ? "Ids, addresses and timestamps are being compared, so most rows will differ."
              : `${data.totals.suppressedFieldChanges} id, address and timestamp difference${
                  data.totals.suppressedFieldChanges === 1 ? "" : "s"
                } hidden — every resource has different ones.`}{" "}
            Nothing here contacts a provider; the comparison reads the last sync.
          </p>
        </>
      )}
    </div>
  );
}

function ResourceName({
  resource,
  pluginId,
  resourceTypeId,
  fallback,
  onOpenResource,
}: {
  resource: EnvironmentDiffResourceRef | null;
  pluginId: string;
  resourceTypeId: string;
  fallback: string;
  onOpenResource?: ((target: EnvironmentDiffResourceTarget) => void) | undefined;
}) {
  if (!resource) {
    return <span className="text-xs text-on-surface-faint">— not in {fallback}</span>;
  }
  if (!onOpenResource) {
    return <span className="whitespace-nowrap text-on-surface">{resource.displayName}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => onOpenResource({ ...resource, pluginId, resourceTypeId })}
      className="whitespace-nowrap text-on-surface hover:underline"
    >
      {resource.displayName}
    </button>
  );
}
