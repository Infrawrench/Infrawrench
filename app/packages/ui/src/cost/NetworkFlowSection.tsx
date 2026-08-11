import {
  attributionCoverage,
  formatFlowBytes,
  NETWORK_FLOW_SCOPE_LABELS,
  type NetworkFlowFeed,
  type NetworkFlowPairView,
  type NetworkFlowScopeSummary,
} from "@infrawrench/client-core";
import { useEffect, useState } from "react";

import { formatMoney } from "./transform.js";
import type { CostsClient } from "./types.js";

/** Pairs shown before the list is cut off. */
const PAIRS_SHOWN = 20;

const SCOPE_TONE: Record<string, string> = {
  internet_egress: "text-danger bg-red-500/10",
  nat_gateway: "text-severe bg-orange-500/10",
  cross_region: "text-warning bg-amber-500/10",
  cross_zone: "text-warning bg-amber-500/10",
  private_interconnect: "text-notice bg-purple-500/10",
  provider_service: "text-success bg-emerald-500/10",
  intra_zone: "text-success bg-emerald-500/10",
  internet_ingress: "text-info bg-sky-500/10",
  unknown: "text-on-surface-tertiary bg-surface-overlay",
};

function endpointName(endpoint: NetworkFlowPairView["source"]): string {
  const zone = endpoint.zone ? ` · ${endpoint.zone}` : "";
  return `${endpoint.label || endpoint.ref}${zone}`;
}

/**
 * The headline: what fraction of the observed bytes this screen can actually
 * explain.
 *
 * Rendered before the itemization rather than after it, because a top-flows
 * list read without it invites exactly the wrong conclusion — that the flows
 * shown *are* the egress bill. Both of the numbers it subtracts are known
 * quantities (an unattributable peer, and a tail computed by subtraction), so
 * this is a measurement and not a confidence score.
 */
function CoverageLine({ feed }: { feed: NetworkFlowFeed }) {
  const coverage = attributionCoverage(feed.totals);
  const priced = feed.scopes.filter((s) => s.estimatedCost > 0);
  const leader = priced[0];
  return (
    <div className="border border-border rounded-xl p-3 space-y-1">
      <p className="text-sm text-on-surface-secondary">
        <span className="font-semibold">
          {formatMoney(feed.totals.estimatedCost, feed.totals.currency)}
        </span>{" "}
        estimated over {formatFlowBytes(feed.totals.bytes)} between {feed.range.from} and{" "}
        {feed.range.to}
        {leader ? (
          <>
            {" "}
            — mostly{" "}
            <span className="font-medium">
              {NETWORK_FLOW_SCOPE_LABELS[leader.scope]} {leader.direction}
            </span>
          </>
        ) : null}
        .
      </p>
      <p className="text-xs text-on-surface-muted">
        {Math.round(coverage * 100)}% of those bytes are attributed to a pair.{" "}
        {feed.totals.unattributedBytes > 0 && (
          <>{formatFlowBytes(feed.totals.unattributedBytes)} could not be tied to a workload. </>
        )}
        {feed.totals.truncatedBytes > 0 && (
          <>{formatFlowBytes(feed.totals.truncatedBytes)} fell below the stored top-pair cap. </>
        )}
        Neither is spread across the rows below.
      </p>
    </div>
  );
}

function ScopeRow({ summary }: { summary: NetworkFlowScopeSummary }) {
  const tone = SCOPE_TONE[summary.scope] ?? SCOPE_TONE["unknown"]!;
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      <span className="flex items-center gap-2 min-w-0">
        <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${tone}`}>
          {NETWORK_FLOW_SCOPE_LABELS[summary.scope]}
        </span>
        <span className="text-xs text-on-surface-muted">{summary.direction}</span>
        {summary.leftCloud && <span className="text-xs text-on-surface-muted">left the cloud</span>}
      </span>
      <span className="flex items-center gap-4 shrink-0">
        <span className="text-xs text-on-surface-muted">{formatFlowBytes(summary.bytes)}</span>
        <span className="tabular-nums">{formatMoney(summary.estimatedCost, summary.currency)}</span>
      </span>
    </li>
  );
}

function PairRow({ pair }: { pair: NetworkFlowPairView }) {
  const tone = SCOPE_TONE[pair.scope] ?? SCOPE_TONE["unknown"]!;
  return (
    <li className="px-3 py-2 text-sm space-y-1">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate">
          <span className="font-medium">{endpointName(pair.source)}</span>
          <span className="text-on-surface-muted"> → </span>
          <span className="font-medium">{endpointName(pair.destination)}</span>
        </span>
        <span className="tabular-nums shrink-0">
          {formatMoney(pair.estimatedCost, pair.currency)}
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs text-on-surface-muted">
        <span className={`px-1.5 py-0.5 rounded font-medium ${tone}`}>
          {NETWORK_FLOW_SCOPE_LABELS[pair.scope]}
        </span>
        <span>{formatFlowBytes(pair.bytes)}</span>
        <span>
          over {pair.days} day{pair.days === 1 ? "" : "s"}
        </span>
        {pair.attribution === "unattributed" && (
          <span className="text-warning">peer not identified</span>
        )}
      </div>
    </li>
  );
}

/**
 * The collection switch.
 *
 * Lives on this section rather than behind a Settings page because the thing it
 * turns on is only meaningful here, and because the sentence that has to be
 * read before flipping it — *this runs queries your provider bills to your own
 * cloud account, every day, until you turn it off* — belongs next to the switch
 * rather than a navigation step away from it.
 *
 * Renders read-only for a host (or a viewer) without the org-settings write.
 */
function CollectionSwitch({
  feed,
  client,
  onChanged,
}: {
  feed: NetworkFlowFeed;
  client: CostsClient;
  onChanged: (enabled: boolean) => void;
}) {
  const update = client.updateNetworkFlowSettings;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (!update) {
    return feed.enabled ? null : (
      <p className="text-xs text-on-surface-muted">
        Collection is off. An organization admin can turn it on.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
        <input
          type="checkbox"
          checked={feed.enabled}
          disabled={saving}
          onChange={(e) => {
            const enabled = e.target.checked;
            setSaving(true);
            setSaveError(null);
            void (async () => {
              try {
                await update({ enabled });
                onChanged(enabled);
              } catch (err: unknown) {
                setSaveError(err instanceof Error ? err.message : String(err));
              } finally {
                setSaving(false);
              }
            })();
          }}
        />
        Collect network flows
      </label>
      <p className="text-xs text-on-surface-muted">
        Runs one query a day against your provider&apos;s flow logs. Your provider bills those
        queries to your own cloud account by the gigabyte scanned.
      </p>
      {saveError && <p className="text-xs text-danger">{saveError}</p>}
    </div>
  );
}

/**
 * What to say when there is no data, which is most of the time and is the part
 * that has to be right.
 *
 * There are four different nothings here and they are not interchangeable:
 * collection is switched off; no connected provider can report flows at all;
 * flow logs exist but cannot be read; or collection is on and working and the
 * network really is quiet. Rendering "0 bytes" for the first three is the
 * failure this whole surface is trying to avoid — it is a claim about the
 * user's network made out of a gap in ours.
 */
function EmptyState({ feed }: { feed: NetworkFlowFeed }) {
  if (!feed.enabled) {
    return (
      <div className="border border-border rounded-xl p-3 space-y-1">
        <p className="text-sm text-on-surface-secondary">Flow collection is off.</p>
        <p className="text-xs text-on-surface-muted">
          Turning it on lets Infrawrench query your provider&apos;s flow logs once a day. Those
          queries are billed to your own cloud account by the gigabyte scanned, so nothing runs
          until an admin enables it in Settings.
        </p>
      </div>
    );
  }

  const capable = feed.accounts.filter((a) => a.supportsFlows);
  if (capable.length === 0) {
    return (
      <div className="border border-border rounded-xl p-3 space-y-1">
        <p className="text-sm text-on-surface-secondary">
          None of your connected providers can report network flows.
        </p>
        <p className="text-xs text-on-surface-muted">
          Flow attribution is available for AWS accounts with VPC Flow Logs delivering to CloudWatch
          Logs in a custom record format. Other providers are not shown as zero here, because that
          would be a claim about their traffic rather than about our coverage.
        </p>
      </div>
    );
  }

  const blocked = capable.flatMap((a) =>
    a.sources.flatMap((s) => (s.usable ? [] : [{ account: a.displayName, source: s }])),
  );
  const failing = capable.filter((a) => a.lastError !== null);

  return (
    <div className="border border-border rounded-xl p-3 space-y-2">
      <p className="text-sm text-on-surface-secondary">Nothing collected yet.</p>
      {failing.map((account) => (
        <p key={account.accountId} className="text-xs text-danger">
          {account.displayName}: {account.lastError}
          {account.lastErrorHelpUrl && (
            <>
              {" "}
              <a
                className="underline"
                href={account.lastErrorHelpUrl}
                target="_blank"
                rel="noreferrer"
              >
                How to fix
              </a>
            </>
          )}
        </p>
      ))}
      {blocked.map(({ account, source }) => (
        <p key={`${account}:${source.id}`} className="text-xs text-warning">
          {account}: {source.unusableReason}
        </p>
      ))}
      {failing.length === 0 && blocked.length === 0 && (
        <p className="text-xs text-on-surface-muted">
          Collection runs once a day and only reads closed days, so the first flows appear within
          about 24 hours of enabling it.
        </p>
      )}
    </div>
  );
}

export interface NetworkFlowSectionProps {
  client: CostsClient;
}

/**
 * Network costs: which two things are talking, across which boundary, and what
 * that costs.
 *
 * Hides itself entirely when the host client has not wired the endpoint —
 * the same rule every other optional section on this panel follows.
 */
export function NetworkFlowSection({ client }: NetworkFlowSectionProps) {
  const [feed, setFeed] = useState<NetworkFlowFeed | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const getNetworkFlows = client.getNetworkFlows;
    if (!getNetworkFlows) return;
    let cancelled = false;
    // Awaited inside try/catch rather than chained: a host implementation may
    // throw *synchronously* (desktop's requires cloud mode) — see
    // CreditBurndownSection.
    void (async () => {
      try {
        const result = await getNetworkFlows();
        if (!cancelled) {
          setFeed(result);
          setError(null);
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (!client.getNetworkFlows) return null;

  const hasData = feed !== null && feed.scopes.length > 0;
  const billable = feed?.rateCards.some((c) => c.queriesBillable) ?? false;
  const sampled = feed?.rateCards.some((c) => c.sampled) ?? false;
  const asOf = feed?.rateCards[0]?.asOf;

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-on-surface-secondary">Network costs</h2>
        <p className="text-xs text-on-surface-muted mt-1">
          Egress and cross-zone traffic by source and destination pair. Every figure is an{" "}
          <strong>estimate</strong>: bytes come from flow logs
          {sampled ? " (which sample)" : ""} and are priced at published list rates
          {asOf ? ` as of ${asOf}` : ""}, with no free tier, volume tier or negotiated discount
          applied. Use the ranking; it will not reconcile to the invoice line.
        </p>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {feed && (
        <CollectionSwitch
          feed={feed}
          client={client}
          onChanged={(enabled) => setFeed({ ...feed, enabled })}
        />
      )}

      {feed && !hasData && <EmptyState feed={feed} />}

      {feed && hasData && (
        <>
          <CoverageLine feed={feed} />

          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-on-surface-secondary">
              Where it goes — by boundary
            </h3>
            <ul className="border border-border rounded-xl divide-y divide-border overflow-hidden">
              {feed.scopes.map((summary) => (
                <ScopeRow key={`${summary.scope}:${summary.direction}`} summary={summary} />
              ))}
            </ul>
          </div>

          {feed.topFlows.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-on-surface-secondary">
                Top flows by estimated cost
              </h3>
              <ul className="border border-border rounded-xl divide-y divide-border overflow-hidden">
                {feed.topFlows.slice(0, PAIRS_SHOWN).map((pair) => (
                  <PairRow
                    key={`${pair.source.ref}:${pair.destination.ref}:${pair.scope}:${pair.direction}`}
                    pair={pair}
                  />
                ))}
              </ul>
              {feed.topFlows.length > PAIRS_SHOWN && (
                <p className="text-xs text-on-surface-muted">
                  {feed.topFlows.length - PAIRS_SHOWN} more pair
                  {feed.topFlows.length - PAIRS_SHOWN === 1 ? "" : "s"} not shown.
                </p>
              )}
            </div>
          )}

          {billable && (
            <p className="text-xs text-on-surface-muted">
              Collecting these flows runs queries your provider bills to your own cloud account.
              {feed.accounts.some((a) => a.lastQueryBytesScanned !== null) && (
                <>
                  {" "}
                  Last collection scanned{" "}
                  {formatFlowBytes(
                    feed.accounts.reduce((sum, a) => sum + (a.lastQueryBytesScanned ?? 0), 0),
                  )}{" "}
                  of log data.
                </>
              )}
            </p>
          )}
        </>
      )}
    </section>
  );
}
