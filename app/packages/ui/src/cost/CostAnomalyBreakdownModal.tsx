import { useMemo, useState } from "react";
import { useGT } from "gt-react";

import {
  COST_ANOMALY_CONTRIBUTOR_FACETS,
  costAnomalyContributorGraphConfig,
  costAnomalyDriver,
  costAnomalyLeadContributor,
  formatContributorShare,
  type CostAnomalyContributor,
  type CostAnomalyContributorFacet,
  type CostAnomalyContributorResource,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { CostGraphCard } from "./CostGraphCard.js";
import { formatMoney } from "./transform.js";
import type { CostAnomaly, CostsClient } from "./types.js";

export interface CostAnomalyBreakdownModalProps {
  anomaly: CostAnomaly;
  /** Draws the chart (it is a `CostApi`) and, when wired, saves it as a report. */
  client: CostsClient;
  /** Open a synced resource's detail page. Omitted, resources are not links. */
  onOpenResource?: ((resource: CostAnomalyContributorResource) => void) | undefined;
  /** Open a saved cost report. Omitted (or no `createCostReport`), there is no save. */
  onOpenCostReport?: ((reportId: string) => void) | undefined;
  onClose: () => void;
}

function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Stable identity of a contributor row, for selection and React keys. */
function contributorId(c: CostAnomalyContributor): string {
  return `${c.facet}\u0000${c.tagKey ?? ""}\u0000${c.key}\u0000${c.other ? "other" : ""}`;
}

/** The facet names, as literal `gt` calls so the extractor sees each one. */
export function useContributorFacetLabel(): (facet: CostAnomalyContributorFacet) => string {
  const gt = useGT();
  return (facet) => {
    switch (facet) {
      case "resource":
        return gt("Resource");
      case "account":
        return gt("Account");
      case "region":
        return gt("Region");
      case "usage_unit":
        return gt("Usage unit");
      case "charge_type":
        return gt("Charge type");
      case "tag":
        return gt("Tag");
    }
  };
}

/** A contributor's display name; a tag reads `key=value`. Data, never translated. */
export function contributorDisplayName(
  c: CostAnomalyContributor,
  otherLabel: string,
  untaggedLabel: string,
): string {
  if (c.other) return otherLabel;
  if (c.facet === "tag") return `${c.tagKey ?? ""}=${c.key || untaggedLabel}`;
  return c.label || c.key;
}

/**
 * What drove an anomaly: the day's rise decomposed by resource, account,
 * region, usage unit, charge type and tag value, with a daily chart of
 * whichever contributor is selected (the driving resource to start with) and
 * the anomalous day shaded.
 *
 * The chart is the "open the cost report for this" view: the same graph a
 * cost report draws, already filtered to the anomaly's scope and the
 * contributor and centred on the day. Saving it makes it an actual report
 * (and pins a note to the day on that report's chart, so the highlight
 * survives the dialog), then opens it.
 */
export function CostAnomalyBreakdownModal({
  anomaly,
  client,
  onOpenResource,
  onOpenCostReport,
  onClose,
}: CostAnomalyBreakdownModalProps) {
  const gt = useGT();
  const facetLabel = useContributorFacetLabel();
  const contributors = useMemo(() => anomaly.contributors ?? [], [anomaly.contributors]);
  const initial =
    costAnomalyDriver(anomaly) ??
    costAnomalyLeadContributor(anomaly) ??
    contributors.find((c) => costAnomalyContributorGraphConfig(anomaly, c) !== null) ??
    null;
  const [selectedId, setSelectedId] = useState<string | null>(
    initial ? contributorId(initial) : null,
  );
  const selected = contributors.find((c) => contributorId(c) === selectedId) ?? null;
  const config = useMemo(
    () => (selected ? costAnomalyContributorGraphConfig(anomaly, selected) : null),
    [anomaly, selected],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const otherLabel = gt("Other (outside your cost scope)");
  const untaggedLabel = gt("untagged");
  const selectedName = selected ? contributorDisplayName(selected, otherLabel, untaggedLabel) : "";
  const createCostReport = client.createCostReport;
  const canSave = Boolean(createCostReport && onOpenCostReport && config);

  async function saveAsReport() {
    if (!selected || !config || !createCostReport || !onOpenCostReport) return;
    setSaving(true);
    setError(null);
    try {
      const report = await createCostReport({
        name: gt("{name} around {day}", { name: selectedName, day: anomaly.day }),
        description: gt("{dimension} anomaly on {day}: {spend} against {baseline}/day.", {
          dimension: anomaly.dimensionKey,
          day: anomaly.day,
          spend: formatMoney(anomaly.actualCents / 100, anomaly.currency),
          baseline: formatMoney(anomaly.baselineCents / 100, anomaly.currency),
        }),
        config,
      });
      // The highlight, made durable: a note on the anomalous day scoped to this
      // report, so its chart marks the day the dialog shaded. Best effort; the
      // report is the point and already exists.
      if (client.createCostAnnotation) {
        await client
          .createCostAnnotation({
            startDate: anomaly.day,
            text: gt("Anomaly: {dimension} spend {spend} against {baseline}/day", {
              dimension: anomaly.dimensionKey,
              spend: formatMoney(anomaly.actualCents / 100, anomaly.currency),
              baseline: formatMoney(anomaly.baselineCents / 100, anomaly.currency),
            }),
            costReportId: report.id,
          })
          .catch(() => undefined);
      }
      onOpenCostReport(report.id);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={gt("What drove this anomaly")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[760px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-4rem)] overflow-y-auto p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">
          {gt("What drove this anomaly")}
        </h2>
        <p className="text-xs text-on-surface-faint mb-4">
          {gt(
            "{dimension} on {day}, compared with the same 28-day baseline detection used. Each breakdown adds up to the whole rise.",
            { dimension: anomaly.dimensionKey, day: formatDay(anomaly.day) },
          )}
        </p>

        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-danger">
            {error}
          </div>
        )}

        {contributors.length === 0 ? (
          <p className="text-sm text-on-surface-faint">
            {gt(
              "No breakdown for this anomaly yet. It is computed from the day's cost rows; providers that bill per service only have no resources to name.",
            )}
          </p>
        ) : (
          <>
            {config && selected ? (
              <div className="mb-3 flex flex-col gap-2">
                {/* The card fills its parent's height, as in a dashboard cell;
                    without a definite one the chart measured 0px tall. */}
                <div className="h-72 [&>*]:h-full">
                  <CostGraphCard
                    title={gt("{facet}: {name}", {
                      facet: facetLabel(selected.facet),
                      name: selectedName,
                    })}
                    config={config}
                    api={client}
                    highlightBucket={anomaly.day}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {selected.resource && onOpenResource && (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenResource(selected.resource!);
                        onClose();
                      }}
                      className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
                    >
                      {gt("Open resource")}
                    </button>
                  )}
                  {canSave && (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void saveAsReport()}
                      className="rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-sm text-white transition-colors disabled:opacity-50"
                    >
                      {saving ? gt("Saving…") : gt("Save as cost report")}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <p className="mb-3 text-xs text-on-surface-faint">
                {gt("Select a contributor to chart its daily spend around the day.")}
              </p>
            )}

            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-on-surface-faint">
                    <th scope="col" className="px-3 py-2 font-medium">
                      {gt("Contributor")}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium text-right">
                      {gt("Baseline / day")}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium text-right">
                      {gt("On the day")}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium text-right">
                      {gt("Rise")}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium text-right">
                      {gt("Share")}
                    </th>
                  </tr>
                </thead>
                {COST_ANOMALY_CONTRIBUTOR_FACETS.map((facet) => {
                  const rows = contributors.filter((c) => c.facet === facet);
                  if (rows.length === 0) return null;
                  return (
                    <tbody key={facet} className="divide-y divide-border/50">
                      <tr>
                        <td
                          colSpan={5}
                          className="bg-surface-sunken px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-on-surface-faint"
                        >
                          {facetLabel(facet)}
                        </td>
                      </tr>
                      {rows.map((c) => {
                        const id = contributorId(c);
                        const chartable = costAnomalyContributorGraphConfig(anomaly, c) !== null;
                        const isSelected = id === selectedId;
                        const name = contributorDisplayName(c, otherLabel, untaggedLabel);
                        return (
                          <tr
                            key={id}
                            className={`text-on-surface-secondary ${isSelected ? "bg-blue-500/10" : ""}`}
                          >
                            <td className="px-3 py-1.5">
                              {chartable ? (
                                <button
                                  type="button"
                                  onClick={() => setSelectedId(id)}
                                  aria-pressed={isSelected}
                                  className="text-left text-on-surface underline decoration-dotted underline-offset-2 hover:text-info"
                                >
                                  {name}
                                </button>
                              ) : (
                                <span className={c.other ? "italic text-on-surface-faint" : ""}>
                                  {name}
                                </span>
                              )}
                              {c.facet === "resource" && !c.other && c.label !== c.key && (
                                <span className="ml-2 text-xs text-on-surface-faint">{c.key}</span>
                              )}
                            </td>
                            <td className="whitespace-nowrap px-3 py-1.5 text-right">
                              {formatMoney(c.baselineCents / 100, anomaly.currency)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-1.5 text-right text-on-surface">
                              {formatMoney(c.actualCents / 100, anomaly.currency)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-1.5 text-right text-danger">
                              +{formatMoney(c.deltaCents / 100, anomaly.currency)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-1.5 text-right">
                              {formatContributorShare(c.share) ?? gt("n/a")}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  );
                })}
              </table>
            </div>
          </>
        )}

        <div className="mt-5 flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            {gt("Close")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
