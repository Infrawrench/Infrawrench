import { useCallback, useEffect, useRef, useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  extendedSupportFindingKey,
  extendedSupportIssueSourceId,
  formatMoney,
  type ExtendedSupportFinding,
  type ExtendedSupportListResponse,
  type ExtendedSupportStatus,
  type ExtendedSupportTotal,
} from "@infrawrench/client-core";
import { FileIssueButton } from "../issue-filing/FileIssueButton.js";
import { useDataString } from "../i18n/data-strings.js";
import type { ExtendedSupportClient } from "./types.js";

export interface ExtendedSupportSectionProps {
  /** Org-scoped (or local-workspace) data access; the hosting panel remounts per org. */
  client: ExtendedSupportClient;
  /** Navigate to a flagged resource's detail view. */
  onOpenResource?: ((finding: ExtendedSupportFinding) => void) | undefined;
  /** Open the provider's upgrade guide outside the app shell. */
  onOpenExternal?: ((url: string) => void) | undefined;
}

const STATUS_TONE: Record<ExtendedSupportStatus, string> = {
  "end-of-life": "border-danger/40 text-danger",
  surcharged: "border-warning/40 text-warning",
  unsupported: "border-warning/40 text-warning",
  upcoming: "border-border text-on-surface-tertiary",
};

function totalsText(totals: ExtendedSupportTotal[]): string {
  return totals.map((t) => formatMoney(t.monthly, t.currency)).join(" + ");
}

/**
 * "Extended support" section of the Costs panel: resources running a version
 * past (or about to leave) its provider's standard support, with the monthly
 * surcharge an upgrade removes. The figure is the provider's billed amount
 * where the host could attribute one, list price otherwise, and the row says
 * which; a resource with no surcharge (no paid extension, or not enrolled)
 * still appears, because a forced upgrade is the other way this ends.
 */
export function ExtendedSupportSection({
  client,
  onOpenResource,
  onOpenExternal,
}: ExtendedSupportSectionProps) {
  const gt = useGT();
  const gtData = useDataString();
  const [data, setData] = useState<ExtendedSupportListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const refresh = useCallback(
    async (force: boolean) => {
      const seq = ++requestSeq.current;
      setError(null);
      try {
        const next = await client.listExtendedSupport(force);
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

  const statusLabel = (status: ExtendedSupportStatus): string => {
    switch (status) {
      case "end-of-life":
        return gt("Past end of support");
      case "surcharged":
        return gt("Paying extended support");
      case "unsupported":
        return gt("Out of standard support");
      case "upcoming":
        return gt("Surcharge upcoming");
    }
  };

  const basisLabel = (f: ExtendedSupportFinding): string | null => {
    switch (f.costBasis) {
      case "billed":
        return gt("billed");
      case "billed-share":
        return gt("share of billed");
      case "list-price":
        return gt("list price");
      default:
        return null;
    }
  };

  const whenLine = (f: ExtendedSupportFinding): string => {
    if (f.status === "upcoming")
      return f.charged
        ? gt("Surcharge starts {date} (in {days} days)", {
            date: f.surchargeStartsOn,
            days: f.daysUntilSurcharge,
          })
        : gt("Standard support ends {date} (in {days} days)", {
            date: f.standardSupportEnds,
            days: f.daysUntilSurcharge,
          });
    if (f.status === "end-of-life")
      return gt("Extended support ended {date}", { date: f.extendedSupportEnds ?? "" });
    const since = gt("Standard support ended {date}", { date: f.standardSupportEnds });
    return f.extendedSupportEnds
      ? `${since} · ${gt("forced upgrade {date}", { date: f.extendedSupportEnds })}`
      : since;
  };

  const openUrl = (url: string) => {
    if (onOpenExternal) onOpenExternal(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  };

  const findings = data?.findings ?? [];
  const failedAccounts = data?.billing?.accounts.filter((a) => a.status === "failed") ?? [];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">{gt("Extended support")}</h2>
          <T>
            <p className="mt-1 text-xs text-on-surface-secondary">
              Clusters and databases on paid extended-support or soon-forced-upgrade versions, with
              the monthly saving from upgrading. Looks <Var>{data?.leadDays ?? 90}</Var> days ahead.
            </p>
          </T>
        </div>
        <button
          type="button"
          onClick={() => void refresh(true)}
          className="shrink-0 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
        >
          {gt("Refresh")}
        </button>
      </div>

      {error !== null && (
        <div role="alert" className="text-sm text-danger">
          {gt("Couldn't check support calendars:")} {error}{" "}
          <button type="button" onClick={() => void refresh(true)} className="underline">
            {gt("Retry")}
          </button>
        </div>
      )}
      {data === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Checking versions against provider support calendars…")}
        </p>
      )}

      {data !== null && findings.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          {gt("Nothing is on an extended-support or end-of-life version.")}
        </p>
      )}

      {data !== null && (data.currentMonthly.length > 0 || data.upcomingMonthly.length > 0) && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {data.currentMonthly.length > 0 && (
            <span className="text-on-surface">
              {gt("Paying now: {amount}/mo", { amount: totalsText(data.currentMonthly) })}
            </span>
          )}
          {data.upcomingMonthly.length > 0 && (
            <span className="text-on-surface-secondary">
              {gt("Starting soon: {amount}/mo", { amount: totalsText(data.upcomingMonthly) })}
            </span>
          )}
        </div>
      )}

      {findings.length > 0 && (
        <div className="border border-border rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {findings.map((f) => (
                <tr
                  key={extendedSupportFindingKey(f)}
                  className="border-b border-border last:border-b-0 align-top"
                >
                  <td className="px-4 py-2.5 whitespace-nowrap font-medium text-on-surface">
                    {onOpenResource ? (
                      <button
                        type="button"
                        className="hover:underline"
                        onClick={() => onOpenResource(f)}
                      >
                        {f.displayName}
                      </button>
                    ) : (
                      f.displayName
                    )}
                    <div className="text-xs font-normal text-on-surface-tertiary">
                      {gtData(f.resourceTypeName)} · {f.accountName}
                      {f.region ? ` · ${f.region}` : ""}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-on-surface-secondary">
                    {f.product} {f.currentVersion}
                    <span className="mx-1 text-on-surface-faint">→</span>
                    <span className="text-on-surface">{f.targetVersion}</span>
                  </td>
                  <td className="px-3 py-2.5 w-full text-on-surface-secondary">
                    <span
                      className={`mr-2 rounded-full border px-2 py-0.5 text-xs ${STATUS_TONE[f.status]}`}
                    >
                      {statusLabel(f.status)}
                    </span>
                    <span className="text-xs">{whenLine(f)}</span>
                    {f.tierLabel && (
                      <div className="mt-1 text-xs text-on-surface-faint">{f.tierLabel}</div>
                    )}
                    {f.nextTier && (
                      <div className="mt-1 text-xs text-on-surface-faint">
                        {f.nextTier.monthlySurcharge !== null && f.currency
                          ? gt("From {date}: {label} ({amount}/mo)", {
                              date: f.nextTier.from,
                              label: f.nextTier.label,
                              amount: formatMoney(f.nextTier.monthlySurcharge, f.currency),
                            })
                          : gt("From {date}: {label}", {
                              date: f.nextTier.from,
                              label: f.nextTier.label,
                            })}
                      </div>
                    )}
                    {f.note && <div className="mt-1 text-xs text-on-surface-faint">{f.note}</div>}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-right text-on-surface">
                    {f.monthlySurcharge !== null && f.currency ? (
                      <>
                        {formatMoney(f.monthlySurcharge, f.currency)}
                        <span className="ml-1 text-xs text-on-surface-faint">/mo</span>
                        <div
                          className="text-xs text-on-surface-faint"
                          title={
                            f.costBasis === "list-price"
                              ? (f.priceNote ?? undefined)
                              : f.billedLineItems.join(", ")
                          }
                        >
                          {basisLabel(f)}
                        </div>
                      </>
                    ) : (
                      <span className="text-xs text-on-surface-faint">
                        {f.charged ? gt("not priced") : gt("no surcharge")}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-right">
                    <button
                      type="button"
                      onClick={() => openUrl(f.upgradeUrl)}
                      className="text-xs font-medium text-info hover:text-info-strong"
                    >
                      {gt("Upgrade guide")}
                    </button>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-right">
                    <FileIssueButton
                      sourceKind="extended_support"
                      sourceId={extendedSupportIssueSourceId(f)}
                      draft={{
                        title: gt("Upgrade {name} from {product} {from} to {to}", {
                          name: f.displayName,
                          product: f.product,
                          from: f.currentVersion,
                          to: f.targetVersion,
                        }),
                        details: [
                          { label: gt("Resource"), value: f.displayName },
                          { label: gt("Type"), value: f.resourceTypeName },
                          { label: gt("Provider"), value: f.pluginName },
                          { label: gt("Account"), value: f.accountName },
                          { label: gt("Region"), value: f.region },
                          { label: gt("Current version"), value: f.currentVersion },
                          { label: gt("Target version"), value: f.targetVersion },
                          { label: gt("Status"), value: statusLabel(f.status) },
                          { label: gt("Standard support ended"), value: f.standardSupportEnds },
                          { label: gt("Forced upgrade"), value: f.extendedSupportEnds },
                          {
                            label: gt("Monthly surcharge"),
                            value:
                              f.monthlySurcharge !== null && f.currency
                                ? `${formatMoney(f.monthlySurcharge, f.currency)}/mo (${basisLabel(f) ?? ""})`
                                : undefined,
                          },
                          { label: gt("Upgrade guide"), value: f.upgradeUrl },
                        ],
                        ...(f.note ? { note: f.note } : {}),
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {failedAccounts.length > 0 && (
        <p role="status" className="text-xs text-warning">
          {gt(
            "Billing couldn't be read for {accounts}, so those rows show list price. For AWS, the credential needs ce:GetCostAndUsage and ce:GetDimensionValues.",
            { accounts: failedAccounts.map((a) => a.accountName).join(", ") },
          )}
        </p>
      )}
      {(data?.billing?.unattributed.length ?? 0) > 0 && (
        <div className="text-xs text-on-surface-secondary">
          <p>
            {gt(
              "Billed extended-support charges no synced resource could be matched to (connect or sync the account that owns them):",
            )}
          </p>
          <ul className="mt-1 list-disc pl-5">
            {data!.billing!.unattributed.map((u) => (
              <li key={`${u.accountId}:${u.region ?? ""}:${u.lineItem}`}>
                {u.accountName} · {u.lineItem}
                {u.region ? ` · ${u.region}` : ""} · {formatMoney(u.monthlyAmount, u.currency)}/mo
              </li>
            ))}
          </ul>
        </div>
      )}
      {findings.length > 0 && (
        <p className="text-xs text-on-surface-faint">
          {gt(
            "Monthly figures assume 730 hours. List prices are one region's published rates (hover for details); billed figures are the provider's last 30 days of charges.",
          )}
        </p>
      )}
    </section>
  );
}
