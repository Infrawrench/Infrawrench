import { useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  DNS_CLASSIFICATION_LABELS,
  type DnsInventoryResponse,
  type DnsRecordEntry,
  type DnsTargetClassification,
  type DnsZoneEntry,
} from "@infrawrench/client-core";
import { useDataString } from "../i18n/data-strings.js";

export interface DnsSectionProps {
  /**
   * The computed inventory, or null while the first load is in flight. Hosts
   * fetch (web: `/dns`, desktop: IPC or the local scan) and hand the response
   * over — this component never talks to a network.
   */
  data: DnsInventoryResponse | null;
  /**
   * Load or refresh failure. With `data` still present the last inventory
   * stays on screen under a banner — a failed refresh must not blank a drawn
   * list.
   */
  error?: string | null | undefined;
  onRetry?: (() => void) | undefined;
  /** Jump to a record's resource detail view. Omitted, names are plain text. */
  onOpenRecord?: ((record: DnsRecordEntry) => void) | undefined;
  /** Jump to a zone's resource detail view. */
  onOpenZone?: ((zone: DnsZoneEntry) => void) | undefined;
}

type StatusFilter = "all" | DnsTargetClassification;

function useFilterOptions(
  gt: ReturnType<typeof useGT>,
): Array<{ key: StatusFilter; label: string }> {
  return [
    { key: "all", label: gt("All") },
    { key: "dangling", label: gt("Dangling") },
    { key: "owned", label: gt("Resolves here") },
    { key: "external", label: gt("External") },
    { key: "not-analysed", label: gt("Not analysed") },
  ];
}

/** Pill tones per bucket, matching the PostureSection translucent-badge recipe. */
const STATUS_BADGE_CLASSES: Record<DnsTargetClassification, string> = {
  dangling: "bg-red-500/10 text-danger",
  owned: "bg-emerald-500/10 text-success",
  external: "bg-surface-overlay text-on-surface-tertiary",
  "not-analysed": "bg-surface-overlay text-on-surface-faint",
};

/** Compact labels for the badge; the long forms read better in prose. */
function useStatusBadgeLabels(
  gt: ReturnType<typeof useGT>,
): Record<DnsTargetClassification, string> {
  return {
    dangling: gt("Dangling"),
    owned: gt("Resolves here"),
    external: gt("External"),
    "not-analysed": gt("Not analysed"),
  };
}

function formatTtl(gt: ReturnType<typeof useGT>, ttl: number | null): string {
  if (ttl === null) return "—";
  if (ttl <= 0) return gt("Default");
  if (ttl === 1) return gt("Auto");
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.round(ttl / 60)}m`;
  if (ttl < 86400) return `${Math.round(ttl / 3600)}h`;
  return `${Math.round(ttl / 86400)}d`;
}

/**
 * One cross-provider view of every DNS zone and record, with each record's
 * target judged against the rest of the workspace. Shared by the web and
 * desktop Domains screens; the `infrawrench dns` CLI prints the same rows as
 * text.
 *
 * The list is records-first because that is where the finding lives; zones are
 * a roll-up above it, which is also the only place a provider-reported record
 * count can be compared against what actually synced.
 */
export function DnsSection({ data, error, onRetry, onOpenRecord, onOpenZone }: DnsSectionProps) {
  const gt = useGT();
  const gtData = useDataString();
  const FILTER_OPTIONS = useFilterOptions(gt);
  const STATUS_BADGE_LABELS = useStatusBadgeLabels(gt);
  const [filter, setFilter] = useState<StatusFilter>("all");

  const records = useMemo(
    () => (data ? data.records.filter((r) => filter === "all" || r.status === filter) : []),
    [data, filter],
  );

  return (
    <div className="flex-1 overflow-auto p-6">
      <h1 className="text-xl font-semibold mb-1">{gt("Domains")}</h1>
      <p className="text-sm text-on-surface-muted mb-6">
        {gt(
          "Every DNS zone and record across your providers in one place, with each record's target checked against the rest of your workspace. Nothing here resolves DNS or calls a provider — it reads the state your accounts last synced.",
        )}
      </p>

      {error != null && data === null && (
        <div role="alert" className="text-sm text-danger">
          {gt("Couldn't load the DNS inventory — {error}", { error })}{" "}
          {onRetry && (
            <button type="button" onClick={onRetry} className="underline">
              {gt("Retry")}
            </button>
          )}
        </div>
      )}
      {data === null && error == null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Reading synced zones and records…")}
        </p>
      )}
      {error != null && data !== null && (
        <p role="alert" className="mb-4 text-xs text-danger">
          {gt("Couldn't refresh — showing the last loaded inventory. {error}", { error })}
        </p>
      )}

      {data !== null && (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-6">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-overlay px-2.5 py-1 text-xs font-medium text-on-surface-tertiary">
              <T>
                <span className="tabular-nums">
                  <Var>{data.counts.zones}</Var>
                </span>{" "}
                zones
              </T>
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-overlay px-2.5 py-1 text-xs font-medium text-on-surface-tertiary">
              <T>
                <span className="tabular-nums">
                  <Var>{data.counts.records}</Var>
                </span>{" "}
                records
              </T>
            </span>
            {(["dangling", "owned", "external"] as const).map((key) => (
              <span
                key={key}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_BADGE_CLASSES[key]}`}
              >
                <span className="tabular-nums">
                  {key === "owned" ? data.counts.owned : data.counts[key]}
                </span>
                {STATUS_BADGE_LABELS[key]}
              </span>
            ))}
          </div>

          {data.zones.length === 0 && data.records.length === 0 ? (
            <p className="text-sm text-on-surface-faint">
              {gt(
                "No DNS zones synced. Connect an account on a provider that manages DNS — Cloudflare, Route 53, Cloud DNS, DigitalOcean, Netlify, Azure DNS or Vercel — and its zones and records appear here after the next sync.",
              )}
            </p>
          ) : (
            <>
              {data.zones.length > 0 && (
                <section className="mb-8">
                  <h2 className="text-sm font-medium text-on-surface mb-2">{gt("Zones")}</h2>
                  <div className="border border-border rounded-xl overflow-hidden">
                    <table className="w-full text-sm">
                      <tbody>
                        {data.zones.map((zone) => (
                          <tr
                            key={zone.resourceId}
                            className="border-b border-border last:border-b-0 hover:bg-surface-raised"
                          >
                            <td className="px-4 py-2.5 align-top font-medium text-on-surface">
                              {/* The zone name is the navigation control, not the
                                  row: a <tr> can be given tabIndex but never a
                                  role a screen reader announces as activatable,
                                  so the name carries the button. */}
                              {onOpenZone ? (
                                <button
                                  type="button"
                                  onClick={() => onOpenZone(zone)}
                                  className="cursor-pointer text-left font-medium text-on-surface hover:underline"
                                >
                                  {zone.domain}
                                </button>
                              ) : (
                                zone.domain
                              )}
                              {zone.isPrivate && (
                                <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-[11px] font-normal text-on-surface-faint">
                                  {gt("Private")}
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap align-top text-xs text-on-surface-tertiary">
                              {zone.pluginName}
                              <span className="text-on-surface-faint"> · {zone.accountName}</span>
                            </td>
                            <td className="px-3 py-2.5 w-full align-top text-xs text-on-surface-tertiary">
                              {gt("{count} record{plural} synced", {
                                count: zone.recordCount,
                                plural: zone.recordCount === 1 ? "" : "s",
                              })}
                              {zone.providerRecordCount !== null &&
                                zone.providerRecordCount !== zone.recordCount && (
                                  <span className="text-on-surface-faint">
                                    {" "}
                                    {gt("· {count} reported by the provider", {
                                      count: zone.providerRecordCount,
                                    })}
                                  </span>
                                )}
                            </td>
                            <td className="px-4 py-2.5 whitespace-nowrap align-top text-right">
                              {zone.danglingCount > 0 && (
                                <span
                                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_BADGE_CLASSES.dangling}`}
                                >
                                  {gt("{count} dangling", { count: zone.danglingCount })}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <h2 className="text-sm font-medium text-on-surface">{gt("Records")}</h2>
                <div
                  role="group"
                  aria-label={gt("Filter records by status")}
                  className="flex items-center gap-1 text-xs"
                >
                  <div className="flex rounded-lg border border-border overflow-hidden">
                    {FILTER_OPTIONS.map((option) => (
                      <button
                        key={option.key}
                        type="button"
                        onClick={() => setFilter(option.key)}
                        aria-pressed={filter === option.key}
                        className={`px-2.5 py-1 transition-colors ${
                          filter === option.key
                            ? "bg-surface-overlay text-on-surface"
                            : "text-on-surface-tertiary hover:text-on-surface-secondary"
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {records.length === 0 ? (
                <p className="text-sm text-on-surface-faint">
                  {filter === "all"
                    ? gt(
                        "No records synced. Several providers list zones without their records — those zones show above with the provider's own record count.",
                      )
                    : gt("No {label} records.", {
                        label: gtData(
                          DNS_CLASSIFICATION_LABELS[filter as DnsTargetClassification],
                        ).toLowerCase(),
                      })}
                </p>
              ) : (
                <div className="border border-border rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <tbody>
                      {records.map((record) => (
                        <tr
                          key={record.resourceId}
                          className="border-b border-border last:border-b-0 hover:bg-surface-raised"
                        >
                          <td className="px-4 py-2.5 whitespace-nowrap align-top">
                            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-on-surface-tertiary">
                              {record.type}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap align-top font-medium text-on-surface">
                            {onOpenRecord ? (
                              <button
                                type="button"
                                onClick={() => onOpenRecord(record)}
                                className="cursor-pointer text-left font-medium text-on-surface hover:underline"
                              >
                                {record.name}
                              </button>
                            ) : (
                              record.name
                            )}
                            {record.proxied && (
                              <span className="ml-2 rounded-full bg-orange-500/10 px-2 py-0.5 text-[11px] font-normal text-severe">
                                {gt("Proxied")}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 w-full align-top text-on-surface-secondary">
                            {record.targets.length === 0 ? (
                              <span className="text-on-surface-faint">—</span>
                            ) : (
                              record.targets.map((target) => (
                                <span key={target.value} className="block break-all">
                                  <span className="font-mono text-xs">{target.value}</span>
                                  {target.service && (
                                    <T>
                                      <span className="block text-xs text-danger">
                                        <Var>{gtData(target.service.label)}</Var> — nothing synced
                                        claims &ldquo;
                                        <Var>{target.service.claimLabel}</Var>&rdquo;.{" "}
                                        <Var>{gtData(target.service.reason)}</Var>
                                      </span>
                                    </T>
                                  )}
                                  {target.resource && (
                                    <span className="block text-xs text-on-surface-faint">
                                      {gtData(target.resource.resourceTypeName)} ·{" "}
                                      {target.resource.displayName}
                                    </span>
                                  )}
                                </span>
                              ))
                            )}
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap align-top text-xs text-on-surface-tertiary">
                            {formatTtl(gt, record.ttl)}
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap align-top text-xs text-on-surface-tertiary">
                            {record.pluginName}
                            <span className="text-on-surface-faint"> · {record.accountName}</span>
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap align-top text-right">
                            <span
                              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_BADGE_CLASSES[record.status]}`}
                            >
                              {STATUS_BADGE_LABELS[record.status]}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {data.skippedNamespaces.length > 0 && (
                <section className="mt-6">
                  <h2 className="text-sm font-medium text-on-surface mb-2">{gt("Not checked")}</h2>
                  <p className="text-xs text-on-surface-faint mb-2">
                    {gt(
                      "A record pointing into one of these provider namespaces is shown as external rather than dangling. We can't tell a name you released from one you never owned without the data below, and guessing would flag records that are perfectly fine.",
                    )}
                  </p>
                  <ul className="flex flex-col gap-1">
                    {data.skippedNamespaces.map((entry) => (
                      <li
                        key={`${entry.pluginId}:${entry.label}`}
                        className="text-xs text-on-surface-tertiary"
                      >
                        <span className="text-on-surface-secondary">{gtData(entry.label)}</span> —{" "}
                        {gtData(entry.reason)}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <p className="mt-4 text-xs text-on-surface-faint">
                {gt(
                  "A dangling record points into a provider namespace this workspace manages that nothing synced claims — the subdomain-takeover signature. Those records also appear on Posture as high-severity findings and alert through the posture channel.",
                )}
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
