import { useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  formatPriceChangeHourly,
  formatPriceChangePercent,
  formatPriceChangeUsd,
  priceChangeDay,
  priceChangePlatformLabel,
  priceChangeVariantLabel,
  PRICE_CHANGE_LIMITS,
  type CatalogPriceChangeResponse,
  type PriceChange,
  type PriceChangeListResponse,
} from "@infrawrench/client-core";
import { useDataString } from "../i18n/data-strings.js";

/** What the Changes view needs from its host. */
export interface PriceChangesClient {
  /** The org's changes (`GET /price-changes`). */
  list(days: number): Promise<PriceChangeListResponse>;
  /** Every change on one platform (`GET /price-changes/catalog`). */
  catalog(query: { platform?: string; days: number }): Promise<CatalogPriceChangeResponse>;
  /** Make a scenario model from a change; absent when the viewer cannot write costs. */
  createScenario?: (changeId: string) => Promise<{ scenarioModelId: string; created: boolean }>;
}

export interface PriceChangeResourceRef {
  accountId: string;
  resourceId: string;
  pluginId: string;
  resourceTypeId: string;
}

export interface PriceChangesViewProps {
  client: PriceChangesClient;
  onOpenExternal?: ((url: string) => void) | undefined;
  onOpenResource?: ((ref: PriceChangeResourceRef) => void) | undefined;
}

const inputClass =
  "rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-accent-subtle";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";
const DAY_OPTIONS = [30, 90, 180, 365] as const;

function impactClass(amount: number): string {
  if (amount > 0) return "text-danger";
  if (amount < 0) return "text-success";
  return "text-on-surface-secondary";
}

/** The org's changes: one row per change, its resources and what it does to the month. */
function OrgChanges({ client, onOpenExternal, onOpenResource }: PriceChangesViewProps) {
  const gt = useGT();
  const gtData = useDataString();
  const [days, setDays] = useState<number>(PRICE_CHANGE_LIMITS.listDays.default);
  const [showAll, setShowAll] = useState(false);
  const [data, setData] = useState<PriceChangeListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<Record<string, "busy" | "done" | string>>({});

  useEffect(() => {
    let cancelled = false;
    client.list(days).then(
      (res) => {
        if (cancelled) return;
        setData(res);
        setError(null);
      },
      (e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : gt("Request failed"));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, days, gt]);

  const shown = useMemo(
    () => (data?.changes ?? []).filter((c) => showAll || !c.belowThreshold),
    [data, showAll],
  );
  const hidden = (data?.changes.length ?? 0) - shown.length;

  const makeScenario = async (change: PriceChange) => {
    if (!client.createScenario) return;
    setScenarios((s) => ({ ...s, [change.id]: "busy" }));
    try {
      await client.createScenario(change.id);
      setScenarios((s) => ({ ...s, [change.id]: "done" }));
    } catch (e) {
      setScenarios((s) => ({
        ...s,
        [change.id]: e instanceof Error ? e.message : gt("Request failed"),
      }));
    }
  };

  return (
    <section className="mb-8">
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <h2 className="text-base font-semibold mr-auto">{gt("Affecting your resources")}</h2>
        <div>
          <label className={labelClass} htmlFor="pch-days">
            {gt("Period")}
          </label>
          <select
            id="pch-days"
            className={inputClass}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {DAY_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {gt("Last {days} days", { days: d })}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-on-surface-secondary">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          {gt("Include changes under your thresholds")}
        </label>
      </div>

      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {data && !data.available && (
        <p className="mb-3 text-sm text-on-surface-faint">
          {gt("Price history is not available on this server.")}
        </p>
      )}
      {data && (
        <p className="mb-2 text-xs text-on-surface-faint" role="status">
          {data.lastScannedAt
            ? gt("Last checked {date}. Alerts skip changes under {amount}/mo or {percent}%.", {
                date: new Date(data.lastScannedAt).toLocaleString(),
                amount: formatPriceChangeUsd(data.minMonthlyImpactCents / 100),
                percent: data.minPercent,
              })
            : gt("Not checked yet. The first check runs within a day.")}
        </p>
      )}

      {data && shown.length === 0 ? (
        <p className="text-sm text-on-surface-faint">
          {hidden > 0
            ? gt("{count} smaller changes are under your thresholds.", { count: hidden })
            : gt("No list-price changes on what you run in this period.")}
        </p>
      ) : (
        shown.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-on-surface-faint">
                  <th className="px-4 py-2 font-medium">{gt("Instance")}</th>
                  <th className="px-3 py-2 font-medium text-right">{gt("Hourly list price")}</th>
                  <th className="px-3 py-2 font-medium">{gt("Effective")}</th>
                  <th className="px-3 py-2 font-medium">{gt("Your resources")}</th>
                  <th className="px-3 py-2 font-medium text-right">{gt("Per month")}</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => {
                  const variant = priceChangeVariantLabel(c.selection);
                  const scenario = scenarios[c.id];
                  const hasScenario = c.scenarioModelId !== null || scenario === "done";
                  return (
                    <tr
                      key={c.id}
                      className={`border-b border-border last:border-b-0 align-top ${
                        c.belowThreshold ? "opacity-60" : ""
                      }`}
                    >
                      <td className="px-4 py-2">
                        <button
                          type="button"
                          className="font-medium text-left hover:underline"
                          onClick={() => onOpenExternal?.(c.pageUrl)}
                        >
                          {c.instanceType}
                        </button>
                        <div className="text-xs text-on-surface-faint">
                          {gtData(priceChangePlatformLabel(c.platform))}
                          {c.region && c.region !== "global" ? ` · ${c.region}` : ""}
                          {variant ? ` · ${variant}` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                        <div>
                          {formatPriceChangeHourly(c.oldHourlyUsd)}
                          {" → "}
                          {formatPriceChangeHourly(c.newHourlyUsd)}
                        </div>
                        <div className={`text-xs ${impactClass(c.percent)}`}>
                          {formatPriceChangePercent(c.percent)}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">
                        <div>{priceChangeDay(c.effectiveAt)}</div>
                        {c.upcoming && (
                          <span className="mt-0.5 inline-block rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning">
                            {gt("Upcoming")}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <button
                          type="button"
                          className="text-left text-on-surface-secondary hover:underline"
                          aria-expanded={expanded === c.id}
                          onClick={() => setExpanded((e) => (e === c.id ? null : c.id))}
                        >
                          {c.approximate
                            ? gt("At least {count} running", { count: c.units })
                            : gt("{count} running", { count: c.units })}
                        </button>
                        {expanded === c.id && (
                          <ul className="mt-1 space-y-0.5">
                            {c.resources.map((r) => (
                              <li key={r.resourceId}>
                                <button
                                  type="button"
                                  className="text-accent hover:underline disabled:text-on-surface-secondary disabled:no-underline"
                                  disabled={!onOpenResource}
                                  onClick={() =>
                                    onOpenResource?.({
                                      accountId: r.accountId,
                                      resourceId: r.resourceId,
                                      pluginId: c.pluginId,
                                      resourceTypeId: r.resourceTypeId,
                                    })
                                  }
                                >
                                  {r.displayName}
                                </button>
                                <span className="text-on-surface-faint">
                                  {r.accountName ? ` · ${r.accountName}` : ""}
                                  {r.units > 1 ? ` · ×${r.units}` : ""}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums font-medium whitespace-nowrap ${impactClass(
                          c.monthlyImpactUsd,
                        )}`}
                      >
                        {formatPriceChangeUsd(c.monthlyImpactUsd, { signed: true })}
                      </td>
                      <td className="px-3 py-2 text-right text-xs">
                        <div className="flex flex-col items-end gap-1">
                          {c.alertedAt && (
                            <span className="text-on-surface-faint">{gt("Alerted")}</span>
                          )}
                          {c.belowThreshold && (
                            <span className="text-on-surface-faint">{gt("Under threshold")}</span>
                          )}
                          {c.suppressionIds.length > 0 && (
                            <span className="text-on-surface-faint">
                              {gt("Marked expected for anomalies")}
                            </span>
                          )}
                          {hasScenario ? (
                            <span className="text-on-surface-faint">
                              {gt("In a scenario model")}
                            </span>
                          ) : (
                            client.createScenario &&
                            c.monthlyImpactUsd !== 0 && (
                              <button
                                type="button"
                                className="text-accent underline underline-offset-2 whitespace-nowrap disabled:opacity-50"
                                disabled={scenario === "busy"}
                                onClick={() => void makeScenario(c)}
                              >
                                {gt("Add to forecast")}
                              </button>
                            )
                          )}
                          {scenario && scenario !== "busy" && scenario !== "done" && (
                            <span className="text-danger">{scenario}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
      {data && shown.length > 0 && hidden > 0 && (
        <p className="mt-2 text-xs text-on-surface-faint">
          {gt("{count} smaller changes are under your thresholds.", { count: hidden })}
        </p>
      )}
    </section>
  );
}

/** Every change on one platform, whether or not the org runs it. */
function CatalogChanges({ client, onOpenExternal }: PriceChangesViewProps) {
  const gt = useGT();
  const gtData = useDataString();
  const [platform, setPlatform] = useState("ec2");
  const [days, setDays] = useState<number>(PRICE_CHANGE_LIMITS.catalogDays.default);
  const [filter, setFilter] = useState("");
  const [data, setData] = useState<CatalogPriceChangeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    client
      .catalog({ platform, days })
      .then(
        (res) => {
          if (cancelled) return;
          setData(res);
          setError(null);
        },
        (e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : gt("Request failed"));
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, platform, days, gt]);

  const needle = filter.trim().toLowerCase();
  const rows = (data?.changes ?? []).filter(
    (c) =>
      !needle ||
      c.instanceType.toLowerCase().includes(needle) ||
      c.region.toLowerCase().includes(needle),
  );

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <h2 className="text-base font-semibold mr-auto">{gt("All catalog changes")}</h2>
        <div>
          <label className={labelClass} htmlFor="pch-platform">
            {gt("Provider")}
          </label>
          <select
            id="pch-platform"
            className={inputClass}
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          >
            {(data?.platforms.length ? data.platforms : [platform]).map((p) => (
              <option key={p} value={p}>
                {gtData(priceChangePlatformLabel(p))}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="pch-catalog-days">
            {gt("Period")}
          </label>
          <select
            id="pch-catalog-days"
            className={inputClass}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {DAY_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {gt("Last {days} days", { days: d })}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="pch-filter">
            {gt("Filter")}
          </label>
          <input
            id="pch-filter"
            className={inputClass}
            value={filter}
            placeholder={gt("Instance type or region")}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {data && !data.available && (
        <p className="mb-3 text-sm text-on-surface-faint">
          {gt("Price history is not available on this server.")}
        </p>
      )}
      {data?.available && (
        <p className="mb-2 text-xs text-on-surface-faint" role="status">
          {loading
            ? gt("Updating…")
            : data.truncated
              ? gt("The {count} most recent changes; narrow the period to see older ones.", {
                  count: data.changes.length,
                })
              : gt("{count} changes", { count: rows.length })}
        </p>
      )}
      {data?.available && rows.length === 0 && !loading && (
        <p className="text-sm text-on-surface-faint">
          {gt("No list-price changes in this period.")}
        </p>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-on-surface-faint">
                <th className="px-4 py-2 font-medium">{gt("Instance")}</th>
                <th className="px-3 py-2 font-medium">{gt("Region")}</th>
                <th className="px-3 py-2 font-medium text-right">{gt("Hourly list price")}</th>
                <th className="px-3 py-2 font-medium text-right">{gt("Change")}</th>
                <th className="px-3 py-2 font-medium">{gt("Effective")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={`${c.instanceType}|${c.region}|${c.variant}|${c.effectiveAt}`}
                  className="border-b border-border last:border-b-0 align-top"
                >
                  <td className="px-4 py-2">
                    <button
                      type="button"
                      className="font-medium text-left hover:underline"
                      onClick={() => onOpenExternal?.(c.pageUrl)}
                    >
                      {c.instanceType}
                    </button>
                    <div className="text-xs text-on-surface-faint">
                      {[
                        c.variant,
                        c.vcpu !== null ? gt("{count} vCPU", { count: c.vcpu }) : "",
                        c.memoryGib !== null ? gt("{count} GiB", { count: c.memoryGib }) : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs">{c.region}</td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                    {formatPriceChangeHourly(c.oldHourlyUsd)}
                    {" → "}
                    {formatPriceChangeHourly(c.newHourlyUsd)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${impactClass(c.percent)}`}>
                    {formatPriceChangePercent(c.percent)}
                  </td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {priceChangeDay(c.effectiveAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * The Price catalog tab's Changes view: list-price changes on what the org
 * runs (with their monthly impact, alert status and a one-click scenario),
 * then every change in the catalog for one provider. Shared by web and
 * desktop (cloud mode).
 */
export function PriceChangesView(props: PriceChangesViewProps) {
  return (
    <div>
      <OrgChanges {...props} />
      <CatalogChanges {...props} />
    </div>
  );
}
