import {
  formatFlowBytes,
  formatCostQuery,
  parseCostQuery,
  KUBERNETES_NETWORK_METHOD_LABELS,
  NETWORK_FLOW_SCOPE_LABELS,
  type CostFilter,
  type KubernetesNetworkReport,
  type KubernetesNetworkRow,
  type NetworkFlowAccountStatus,
  type NetworkFlowPairView,
  type NetworkFlowScope,
} from "@infrawrench/client-core";
import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import { useDataString } from "../i18n/data-strings.js";

import { CostFilterEditor } from "./CostFilterEditor.js";
import { formatMoney } from "./transform.js";
import type { CostsClient } from "./types.js";
import { selectBaseClass } from "./form-styles.js";

/** Rows shown per table before the list is cut off. */
const ROWS_SHOWN = 15;

const SCOPE_TONE: Record<string, string> = {
  internet_egress: "text-danger bg-red-500/10",
  nat_gateway: "text-severe bg-orange-500/10",
  cross_region: "text-warning bg-amber-500/10",
  cross_zone: "text-warning bg-amber-500/10",
  provider_service: "text-success bg-emerald-500/10",
  intra_zone: "text-success bg-emerald-500/10",
  unknown: "text-on-surface-tertiary bg-surface-overlay",
};

function money(
  report: KubernetesNetworkReport,
  row: { estimatedCost: number; allocatedCost: number | null },
) {
  return formatMoney(row.allocatedCost ?? row.estimatedCost, report.currency);
}

function ScopeBadge({ scope }: { scope: NetworkFlowScope }) {
  const gtData = useDataString();
  const tone = SCOPE_TONE[scope] ?? SCOPE_TONE["unknown"]!;
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${tone}`}>
      {gtData(NETWORK_FLOW_SCOPE_LABELS[scope])}
    </span>
  );
}

/** The dominant boundaries of a row, as a compact list of badges. */
function ScopeMix({ row }: { row: KubernetesNetworkRow }) {
  const entries = (Object.entries(row.byScope) as [NetworkFlowScope, number][])
    .filter(([, bytes]) => bytes > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  return (
    <span className="flex flex-wrap gap-1">
      {entries.map(([scope]) => (
        <ScopeBadge key={scope} scope={scope} />
      ))}
    </span>
  );
}

function RowTable({
  report,
  rows,
  title,
}: {
  report: KubernetesNetworkReport;
  rows: KubernetesNetworkRow[];
  title: string;
}) {
  const gt = useGT();
  const gtData = useDataString();
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-on-surface-secondary">{title}</h3>
      <ul className="border border-border rounded-xl divide-y divide-border overflow-hidden">
        {rows.slice(0, ROWS_SHOWN).map((row) => (
          <li key={row.key} className="px-3 py-2 text-sm space-y-1">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate font-medium">{row.label}</span>
              <span className="tabular-nums shrink-0">{money(report, row)}</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-on-surface-muted">
              <ScopeMix row={row} />
              <span>{formatFlowBytes(row.bytes)}</span>
              {row.method && (
                <span className={row.method === "counter_estimate" ? "text-warning" : undefined}>
                  {gtData(KUBERNETES_NETWORK_METHOD_LABELS[row.method])}
                </span>
              )}
              {row.kind === "node" && <span>{gt("not tied to a pod")}</span>}
            </div>
          </li>
        ))}
      </ul>
      {rows.length > ROWS_SHOWN && (
        <p className="text-xs text-on-surface-muted">
          {gt("{count} more not shown.", { count: rows.length - ROWS_SHOWN })}
        </p>
      )}
    </div>
  );
}

function TalkerRow({ pair }: { pair: NetworkFlowPairView }) {
  return (
    <li className="px-3 py-2 text-sm space-y-1">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate">
          <span className="font-medium">{pair.source.label || pair.source.ref}</span>
          <span className="text-on-surface-muted"> → </span>
          <span className="font-medium">{pair.destination.label || pair.destination.ref}</span>
        </span>
        <span className="tabular-nums shrink-0">
          {formatMoney(pair.estimatedCost, pair.currency)}
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs text-on-surface-muted">
        <ScopeBadge scope={pair.scope} />
        <span>{formatFlowBytes(pair.bytes)}</span>
        {pair.source.zone && <span>{pair.source.zone}</span>}
      </div>
    </li>
  );
}

/**
 * The headline: estimate, billed, allocated and the remainder, in that order,
 * because the allocated figure means nothing without the billed figure it was
 * cut from and the remainder nobody's traffic explained.
 */
function Headline({ report }: { report: KubernetesNetworkReport }) {
  const gt = useGT();
  const gtData = useDataString();
  const observed = report.methods
    .filter((m) => m.method === "flow_log")
    .reduce((a, m) => a + m.bytes, 0);
  const counterOnly = report.methods
    .filter((m) => m.method === "counter_estimate")
    .reduce((a, m) => a + m.bytes, 0);
  const share = (bytes: number) =>
    report.totals.bytes > 0 ? Math.round((bytes / report.totals.bytes) * 100) : 0;
  const billed = report.billed;
  return (
    <div className="border border-border rounded-xl p-3 space-y-1">
      <p className="text-sm text-on-surface-secondary">
        {gt("{estimate} estimated at list price over {bytes} between {from} and {to}.", {
          estimate: formatMoney(report.totals.estimatedCost, report.currency),
          bytes: formatFlowBytes(report.totals.bytes),
          from: report.range.from,
          to: report.range.to,
        })}
      </p>
      {billed.billedCost !== null && (
        <p className="text-sm text-on-surface-secondary">
          {gt(
            "{billed} billed for this cluster's data transfer: {allocated} allocated to workloads, {unallocated} not explained by observed traffic.",
            {
              billed: formatMoney(billed.billedCost, report.currency),
              allocated: formatMoney(report.totals.allocatedCost ?? 0, report.currency),
              unallocated: formatMoney(report.totals.unallocatedCost ?? 0, report.currency),
            },
          )}
        </p>
      )}
      {billed.basis === "bytes" && (
        <p className="text-xs text-warning">
          {gt(
            "No traffic in this range had a known boundary, so the billed amount was split by bytes alone. Treat it as a ranking, not a bill.",
          )}
        </p>
      )}
      {billed.scaledDays > 0 && (
        <p className="text-xs text-on-surface-muted">
          {gt(
            "On {days} day(s) the bill came in under the list estimate (a free allowance or a discount), so every row was scaled down by the same factor.",
            { days: billed.scaledDays },
          )}
        </p>
      )}
      {billed.daysWithoutBilled > 0 && (
        <p className="text-xs text-on-surface-muted">
          {gt(
            "{days} day(s) have traffic but no billed rows yet, so nothing was allocated for them.",
            {
              days: billed.daysWithoutBilled,
            },
          )}
        </p>
      )}
      {billed.error && <p className="text-xs text-danger">{billed.error}</p>}
      <p className="text-xs text-on-surface-muted">
        {gt(
          "{observed}% of bytes have boundaries from cloud flow logs; {counter}% come from pod counters alone, with no destination.",
          { observed: share(observed), counter: share(counterOnly) },
        )}{" "}
        {report.methods.length > 0 &&
          report.methods
            .map((m) => `${gtData(KUBERNETES_NETWORK_METHOD_LABELS[m.method])} ${share(m.bytes)}%`)
            .join(" · ")}
      </p>
    </div>
  );
}

/** Which sources the cluster offered on its last collection, and what fixes the rest. */
function Sources({ status }: { status: NetworkFlowAccountStatus | null }) {
  const gt = useGT();
  if (!status) return null;
  return (
    <div className="space-y-1">
      {status.lastError && (
        <p className="text-xs text-danger">
          {status.lastError}
          {status.lastErrorHelpUrl && (
            <>
              {" "}
              <a
                className="underline"
                href={status.lastErrorHelpUrl}
                target="_blank"
                rel="noreferrer"
              >
                {gt("How to fix")}
              </a>
            </>
          )}
        </p>
      )}
      {status.sources
        .filter((s) => !s.usable && s.unusableReason)
        .map((s) => (
          <p key={s.id} className="text-xs text-on-surface-muted">
            {s.unusableReason}
            {s.helpUrl && (
              <>
                {" "}
                <a className="underline" href={s.helpUrl} target="_blank" rel="noreferrer">
                  {gt("Docs")}
                </a>
              </>
            )}
          </p>
        ))}
    </div>
  );
}

/**
 * The billed source: which cost rows are this cluster's data transfer.
 *
 * Built from the same filter editor the cost graphs use, so the account and
 * service values come from pickers over the org's own cost data rather than
 * from a service name the user has to know. Stored as cost query text.
 */
function BilledSourceEditor({
  client,
  accountId,
  query,
  onSaved,
}: {
  client: CostsClient;
  accountId: string;
  query: string | null;
  onSaved: () => void;
}) {
  const gt = useGT();
  const update = client.updateKubernetesNetworkSettings;
  const initial = (() => {
    try {
      return query ? parseCostQuery(query) : [];
    } catch {
      return [];
    }
  })();
  const [filters, setFilters] = useState<CostFilter[]>(initial);
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = async (next: CostFilter[]) => {
    if (!update) return;
    setSaving(true);
    setSaveError(null);
    try {
      await update(accountId, { billedQuery: next.length > 0 ? formatCostQuery(next) : null });
      setEditing(false);
      onSaved();
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border border-border rounded-xl p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-on-surface-secondary">
          {gt("Billed data transfer")}
        </h3>
        {update && !editing && (
          <button type="button" className="text-xs underline" onClick={() => setEditing(true)}>
            {query ? gt("Edit") : gt("Set up")}
          </button>
        )}
      </div>
      {!editing && (
        <p className="text-xs text-on-surface-muted">
          {query
            ? gt("Allocating the cost rows matching: {query}", { query })
            : gt(
                "Not set. Pick the cost rows that are this cluster's data transfer (for example its cloud account and the data-transfer service) to split the real bill across workloads instead of showing list prices.",
              )}
        </p>
      )}
      {editing && (
        <>
          <CostFilterEditor
            filters={filters}
            onChange={setFilters}
            api={client}
            onErrorChange={setInvalid}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-sm text-white transition-colors disabled:opacity-50"
              disabled={saving || invalid !== null || filters.length === 0}
              onClick={() => void save(filters)}
            >
              {gt("Save")}
            </button>
            {query && (
              <button
                type="button"
                className="rounded-lg border border-border px-3 py-1.5 text-sm"
                disabled={saving}
                onClick={() => void save([])}
              >
                {gt("Clear")}
              </button>
            )}
            <button
              type="button"
              className="px-3 py-1.5 text-sm text-on-surface-muted"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              {gt("Cancel")}
            </button>
          </div>
        </>
      )}
      {saveError && <p className="text-xs text-danger">{saveError}</p>}
    </div>
  );
}

export interface KubernetesNetworkSectionProps {
  client: CostsClient;
}

/**
 * Kubernetes network costs: one cluster's traffic by namespace, workload and
 * boundary, top talkers, and the cluster's billed data transfer apportioned
 * across it.
 *
 * Hides itself when the host has not wired the endpoint, or when the org has
 * no cluster that reports pod traffic: there is nothing to pick.
 */
export function KubernetesNetworkSection({ client }: KubernetesNetworkSectionProps) {
  const gt = useGT();
  const [clusters, setClusters] = useState<NetworkFlowAccountStatus[] | null>(null);
  const [accountId, setAccountId] = useState<string>("");
  const [report, setReport] = useState<KubernetesNetworkReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const getNetworkFlows = client.getNetworkFlows;
    if (!getNetworkFlows || !client.getKubernetesNetwork) return;
    let cancelled = false;
    void (async () => {
      try {
        const feed = await getNetworkFlows({ limit: 1 });
        if (cancelled) return;
        const list = feed.accounts.filter((a) => a.supportsFlows && a.recut);
        setClusters(list);
        setAccountId((current) => current || list[0]?.accountId || "");
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    const getKubernetesNetwork = client.getKubernetesNetwork;
    if (!getKubernetesNetwork || !accountId) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await getKubernetesNetwork(accountId);
        if (!cancelled) {
          setReport(result);
          setError(null);
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, accountId, reloadKey]);

  if (!client.getKubernetesNetwork || !client.getNetworkFlows) return null;
  if (clusters !== null && clusters.length === 0) return null;

  const workloads = report?.workloads.filter((r) => r.kind !== "namespace") ?? [];

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface-secondary">
            {gt("Kubernetes network costs")}
          </h2>
          <p className="text-xs text-on-surface-muted mt-1">
            {gt(
              "Pod traffic by namespace and workload, split into same-zone, cross-zone, cross-region and internet. Kept out of the network totals above, because the same bytes also leave through the nodes' own interfaces.",
            )}
          </p>
        </div>
        {clusters && clusters.length > 1 && (
          <select
            className={selectBaseClass}
            value={accountId}
            aria-label={gt("Cluster")}
            onChange={(e) => {
              setReport(null);
              setAccountId(e.target.value);
            }}
          >
            {clusters.map((c) => (
              <option key={c.accountId} value={c.accountId}>
                {c.displayName}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {report && (
        <>
          <Sources status={report.collection} />
          {report.totals.bytes === 0 ? (
            <p className="text-xs text-on-surface-muted">
              {gt(
                "Nothing collected for this cluster yet. Collection reads the previous closed day once a day, after network flow collection is turned on above.",
              )}
            </p>
          ) : (
            <>
              <Headline report={report} />
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-on-surface-secondary">
                  {gt("By traffic class")}
                </h3>
                <ul className="border border-border rounded-xl divide-y divide-border overflow-hidden">
                  {report.scopes.map((s) => (
                    <li
                      key={s.scope}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                    >
                      <ScopeBadge scope={s.scope} />
                      <span className="flex items-center gap-4 shrink-0">
                        <span className="text-xs text-on-surface-muted">
                          {formatFlowBytes(s.bytes)}
                        </span>
                        <span className="tabular-nums">{money(report, s)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <RowTable report={report} rows={report.namespaces} title={gt("By namespace")} />
              <RowTable report={report} rows={workloads} title={gt("By workload")} />
              {report.topTalkers.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold text-on-surface-secondary">
                    {gt("Top talkers")}
                  </h3>
                  <ul className="border border-border rounded-xl divide-y divide-border overflow-hidden">
                    {report.topTalkers.slice(0, ROWS_SHOWN).map((pair) => (
                      <TalkerRow
                        key={`${pair.source.ref}:${pair.source.zone}:${pair.destination.ref}:${pair.scope}`}
                        pair={pair}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
          <BilledSourceEditor
            key={`${report.accountId}:${report.billed.query ?? ""}`}
            client={client}
            accountId={report.accountId}
            query={report.billed.query}
            onSaved={() => setReloadKey((k) => k + 1)}
          />
        </>
      )}
    </section>
  );
}
