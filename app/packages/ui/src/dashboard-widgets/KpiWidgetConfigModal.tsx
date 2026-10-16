import { useEffect, useId, useState } from "react";
import { useGT } from "gt-react";
import {
  COST_RANGE_PRESETS,
  COST_RANGE_PRESET_LABELS,
  KPI_AGGREGATIONS,
  KPI_BUDGET_MEASURES,
  KPI_COMMITMENT_MEASURES,
  KPI_REPORT_MEASURES,
  KPI_SOURCE_KINDS,
  SAVINGS_EVENT_KINDS,
  defaultKpiUpIsGood,
  kpiAggregationApplies,
  kpiSourceUsesDateRange,
  kpiWidgetConfigProblem,
  type BudgetWithStatus,
  type CostRangePreset,
  type CostReport,
  type KpiSourceKind,
  type KpiWidgetConfig,
  type KpiWidgetSource,
  type SavingsEventKind,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { labelClass, selectClass } from "../cost/form-styles.js";
import { savingsKindLabel } from "../cost/RealizedSavingsSection.js";
import { useDataString } from "../i18n/data-strings.js";
import { KpiWidgetCard, type DashboardKpiEvaluator } from "./KpiWidgetCard.js";
import {
  kpiAggregationLabel,
  kpiBudgetMeasureLabel,
  kpiCommitmentMeasureLabel,
  kpiReportMeasureLabel,
  kpiSourceKindLabel,
} from "./labels.js";

/** The source a kind starts on, picking the first object of that kind when there is one. */
function sourceFor(
  kind: KpiSourceKind,
  reports: CostReport[] | null,
  budgets: BudgetWithStatus[] | null,
): KpiWidgetSource {
  switch (kind) {
    case "cost_report":
      return {
        kind,
        reportId: reports?.[0]?.id ?? "",
        measure: "cost",
        aggregation: "sum",
      };
    case "budget":
      return { kind, budgetId: budgets?.[0]?.id ?? "", measure: "actual" };
    case "commitments":
      return { kind, measure: "coverage" };
    case "realized_savings":
      return { kind };
  }
}

/** Drop the fields a source change made meaningless. */
function normalize(config: KpiWidgetConfig): KpiWidgetConfig {
  const next: KpiWidgetConfig = { ...config };
  if (!kpiSourceUsesDateRange(next.source)) delete next.dateRange;
  if (next.source.kind === "cost_report") {
    const source = { ...next.source };
    if (!kpiAggregationApplies(source)) source.aggregation = "sum";
    if (source.measure !== "usage") delete source.usageUnit;
    next.source = source;
  }
  return next;
}

/**
 * Configure a KPI card. Every source is a picker over objects the org already
 * has (its saved reports, its budgets), never an id typed by hand, and a
 * preview answers the question as it is being built.
 */
export function KpiWidgetConfigModal({
  initialTitle,
  initialConfig,
  loadReports,
  loadBudgets,
  listUsageUnits,
  evaluate,
  onSave,
  onClose,
}: {
  initialTitle: string;
  initialConfig: KpiWidgetConfig;
  loadReports: () => Promise<CostReport[]>;
  loadBudgets: () => Promise<BudgetWithStatus[]>;
  /** The usage units the org's cost rows carry; without it, usage is only offered for reports that measure one. */
  listUsageUnits?: (() => Promise<Array<{ unit: string }>>) | undefined;
  /** Answers the preview; omitted, the editor saves without one. */
  evaluate?: DashboardKpiEvaluator | undefined;
  onSave: (title: string, config: KpiWidgetConfig) => Promise<void> | void;
  onClose: () => void;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const uid = useId();
  const [title, setTitle] = useState(initialTitle);
  const [config, setConfig] = useState<KpiWidgetConfig>(initialConfig);
  const [reports, setReports] = useState<CostReport[] | null>(null);
  const [budgets, setBudgets] = useState<BudgetWithStatus[] | null>(null);
  const [usageUnits, setUsageUnits] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<KpiWidgetConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadReports(), loadBudgets()])
      .then(([r, b]) => {
        if (cancelled) return;
        setReports([...r].sort((x, y) => x.name.localeCompare(y.name)));
        setBudgets([...b].sort((x, y) => x.name.localeCompare(y.name)));
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    if (listUsageUnits) {
      listUsageUnits()
        .then((units) => {
          if (!cancelled) setUsageUnits(units.map((u) => u.unit));
        })
        .catch(() => {
          if (!cancelled) setUsageUnits([]);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [loadReports, loadBudgets, listUsageUnits]);

  // A new card with no report picked yet starts on the first one, once known.
  useEffect(() => {
    setConfig((c) =>
      c.source.kind === "cost_report" && !c.source.reportId && reports?.[0]
        ? { ...c, source: { ...c.source, reportId: reports[0].id } }
        : c.source.kind === "budget" && !c.source.budgetId && budgets?.[0]
          ? { ...c, source: { ...c.source, budgetId: budgets[0].id } }
          : c,
    );
  }, [reports, budgets]);

  const source = config.source;
  const report =
    source.kind === "cost_report" ? reports?.find((r) => r.id === source.reportId) : undefined;
  const complete =
    (source.kind !== "cost_report" || Boolean(source.reportId)) &&
    (source.kind !== "budget" || Boolean(source.budgetId));
  const problem = kpiWidgetConfigProblem(config);
  const reportHasMetric = Boolean(
    report && (report.config.unitCostMetricId || report.config.unitCostMode === "usage_unit_cost"),
  );
  const reportUsageUnit =
    report?.config.measure === "usage" ? (report.config.usageUnit ?? null) : null;

  // The preview follows the form a moment behind, so typing a title or
  // flicking through measures does not fire a query per keystroke.
  const configKey = JSON.stringify(config);
  useEffect(() => {
    if (!complete || problem) {
      setPreview(null);
      return;
    }
    const timer = setTimeout(() => setPreview(JSON.parse(configKey) as KpiWidgetConfig), 400);
    return () => clearTimeout(timer);
  }, [configKey, complete, problem]);

  const set = (patch: Partial<KpiWidgetConfig>) => setConfig((c) => normalize({ ...c, ...patch }));
  const setSource = (patch: Partial<KpiWidgetSource>) =>
    setConfig((c) => normalize({ ...c, source: { ...c.source, ...patch } as KpiWidgetSource }));

  const upDefault = defaultKpiUpIsGood(source);
  const rangeValue = config.dateRange?.kind === "relative" ? config.dateRange.preset : "source";

  async function submit() {
    if (!complete || problem) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(title.trim(), config);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={gt("KPI card")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[620px] max-w-full p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-on-surface">{gt("KPI card")}</h2>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label htmlFor={`${uid}-title`} className={labelClass}>
              {gt("Title (optional)")}
            </label>
            <input
              id={`${uid}-title`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={selectClass}
            />
          </div>

          <div>
            <label htmlFor={`${uid}-kind`} className={labelClass}>
              {gt("Source")}
            </label>
            <select
              id={`${uid}-kind`}
              className={selectClass}
              value={source.kind}
              onChange={(e) =>
                setConfig((c) =>
                  normalize({
                    ...c,
                    source: sourceFor(e.target.value as KpiSourceKind, reports, budgets),
                    // A new source's direction is its own default again.
                    upIsGood: undefined,
                  }),
                )
              }
            >
              {KPI_SOURCE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {kpiSourceKindLabel(gt, k)}
                </option>
              ))}
            </select>
          </div>

          {source.kind === "cost_report" && (
            <>
              <div>
                <label htmlFor={`${uid}-report`} className={labelClass}>
                  {gt("Report")}
                </label>
                <select
                  id={`${uid}-report`}
                  className={selectClass}
                  value={source.reportId}
                  disabled={!reports || reports.length === 0}
                  onChange={(e) => setSource({ reportId: e.target.value })}
                >
                  {!reports && <option value="">{gt("Loading…")}</option>}
                  {reports?.length === 0 && <option value="">{gt("No saved reports yet")}</option>}
                  {reports?.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`${uid}-measure`} className={labelClass}>
                  {gt("Measure")}
                </label>
                <select
                  id={`${uid}-measure`}
                  className={selectClass}
                  value={source.measure}
                  onChange={(e) =>
                    setSource({ measure: e.target.value as (typeof KPI_REPORT_MEASURES)[number] })
                  }
                >
                  {KPI_REPORT_MEASURES.map((m) => (
                    <option key={m} value={m}>
                      {kpiReportMeasureLabel(gt, m)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`${uid}-aggregation`} className={labelClass}>
                  {gt("Aggregation")}
                </label>
                <select
                  id={`${uid}-aggregation`}
                  className={selectClass}
                  value={source.aggregation}
                  disabled={!kpiAggregationApplies(source)}
                  onChange={(e) =>
                    setSource({ aggregation: e.target.value as (typeof KPI_AGGREGATIONS)[number] })
                  }
                >
                  {KPI_AGGREGATIONS.map((a) => (
                    <option key={a} value={a}>
                      {kpiAggregationLabel(gt, a)}
                    </option>
                  ))}
                </select>
              </div>
              {source.measure === "usage" && !reportUsageUnit && (
                <div className="col-span-2">
                  <label htmlFor={`${uid}-unit`} className={labelClass}>
                    {gt("Usage unit")}
                  </label>
                  <select
                    id={`${uid}-unit`}
                    className={selectClass}
                    value={source.usageUnit ?? ""}
                    onChange={(e) => setSource({ usageUnit: e.target.value || undefined })}
                  >
                    <option value="">{gt("Pick a unit")}</option>
                    {(usageUnits ?? []).map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {(source.measure === "unit_cost" || source.measure === "business_metric") &&
                report &&
                !reportHasMetric && (
                  <p className="col-span-2 text-[11px] text-warning">
                    {gt(
                      "This report has no business metric attached. Attach one in the report's unit cost settings to use this measure.",
                    )}
                  </p>
                )}
              {source.measure === "count" && report?.config.groupBy === "none" && (
                <p className="col-span-2 text-[11px] text-warning">
                  {gt(
                    "A distinct count counts the values of the report's group-by, and this report is not grouped.",
                  )}
                </p>
              )}
            </>
          )}

          {source.kind === "budget" && (
            <>
              <div>
                <label htmlFor={`${uid}-budget`} className={labelClass}>
                  {gt("Budget")}
                </label>
                <select
                  id={`${uid}-budget`}
                  className={selectClass}
                  value={source.budgetId}
                  disabled={!budgets || budgets.length === 0}
                  onChange={(e) => setSource({ budgetId: e.target.value })}
                >
                  {!budgets && <option value="">{gt("Loading…")}</option>}
                  {budgets?.length === 0 && <option value="">{gt("No budgets yet")}</option>}
                  {budgets?.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-2">
                <label htmlFor={`${uid}-budget-measure`} className={labelClass}>
                  {gt("Show")}
                </label>
                <select
                  id={`${uid}-budget-measure`}
                  className={selectClass}
                  value={source.measure}
                  onChange={(e) =>
                    setSource({ measure: e.target.value as (typeof KPI_BUDGET_MEASURES)[number] })
                  }
                >
                  {KPI_BUDGET_MEASURES.map((m) => (
                    <option key={m} value={m}>
                      {kpiBudgetMeasureLabel(gt, m)}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-on-surface-faint">
                  {gt(
                    "A budget KPI follows the budget's own period and compares with the same point of the previous one.",
                  )}
                </p>
              </div>
            </>
          )}

          {source.kind === "commitments" && (
            <div>
              <label htmlFor={`${uid}-commitment-measure`} className={labelClass}>
                {gt("Show")}
              </label>
              <select
                id={`${uid}-commitment-measure`}
                className={selectClass}
                value={source.measure}
                onChange={(e) =>
                  setSource({
                    measure: e.target.value as (typeof KPI_COMMITMENT_MEASURES)[number],
                  })
                }
              >
                {KPI_COMMITMENT_MEASURES.map((m) => (
                  <option key={m} value={m}>
                    {kpiCommitmentMeasureLabel(gt, m)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {source.kind === "realized_savings" && (
            <div>
              <label htmlFor={`${uid}-savings-kind`} className={labelClass}>
                {gt("Kind of saving")}
              </label>
              <select
                id={`${uid}-savings-kind`}
                className={selectClass}
                value={source.eventKind ?? ""}
                onChange={(e) =>
                  setSource({ eventKind: (e.target.value || undefined) as SavingsEventKind })
                }
              >
                <option value="">{gt("Every kind")}</option>
                {SAVINGS_EVENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {savingsKindLabel(gt, k)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {kpiSourceUsesDateRange(source) ? (
            <div>
              <label htmlFor={`${uid}-range`} className={labelClass}>
                {gt("Date range")}
              </label>
              <select
                id={`${uid}-range`}
                className={selectClass}
                value={rangeValue}
                onChange={(e) =>
                  set({
                    dateRange:
                      e.target.value === "source"
                        ? undefined
                        : { kind: "relative", preset: e.target.value as CostRangePreset },
                  })
                }
              >
                <option value="source">
                  {source.kind === "cost_report" ? gt("Same as the report") : gt("Last 30 days")}
                </option>
                {COST_RANGE_PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {gtData(COST_RANGE_PRESET_LABELS[p])}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            source.kind === "commitments" && (
              <p className="col-span-2 text-[11px] text-on-surface-faint">
                {gt(
                  "Coverage and utilization are measured over the commitments service's trailing 30 days.",
                )}
              </p>
            )
          )}

          <div>
            <label htmlFor={`${uid}-direction`} className={labelClass}>
              {gt("A rise is")}
            </label>
            <select
              id={`${uid}-direction`}
              className={selectClass}
              value={config.upIsGood === undefined ? "auto" : config.upIsGood ? "good" : "bad"}
              onChange={(e) =>
                set({
                  upIsGood: e.target.value === "auto" ? undefined : e.target.value === "good",
                })
              }
            >
              <option value="auto">
                {upDefault ? gt("Automatic (good news)") : gt("Automatic (bad news)")}
              </option>
              <option value="good">{gt("Good news")}</option>
              <option value="bad">{gt("Bad news")}</option>
            </select>
          </div>

          <label className="col-span-2 flex items-center gap-2 text-sm text-on-surface">
            <input
              type="checkbox"
              checked={config.comparePreviousPeriod}
              onChange={(e) => set({ comparePreviousPeriod: e.target.checked })}
            />
            {gt("Compare with the previous period")}
          </label>
        </div>

        {loadError && (
          <p role="alert" className="text-sm text-danger">
            {loadError}
          </p>
        )}
        {problem && (
          <p role="alert" className="text-sm text-danger">
            {problem}
          </p>
        )}

        {evaluate && preview && (
          <div>
            <p className={labelClass}>{gt("Preview")}</p>
            <div className="w-64 max-w-full">
              <KpiWidgetCard title={title.trim()} config={preview} evaluate={evaluate} />
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface"
          >
            {gt("Cancel")}
          </button>
          <button
            type="button"
            disabled={busy || !complete || Boolean(problem)}
            onClick={() => void submit()}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {gt("Save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
