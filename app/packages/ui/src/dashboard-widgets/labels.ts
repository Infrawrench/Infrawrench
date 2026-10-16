import type { useGT } from "gt-react";
import type {
  KpiAggregation,
  KpiBudgetMeasure,
  KpiCommitmentMeasure,
  KpiReportMeasure,
  KpiSourceKind,
  KpiWidgetConfig,
} from "@infrawrench/client-core";
import { savingsKindLabel } from "../cost/RealizedSavingsSection.js";

type Gt = ReturnType<typeof useGT>;

/*
 * Translated labels for the KPI enums. Written out per value because the
 * translation extractor only sees literal strings; the English maps in
 * client-core are for surfaces with no translation layer (CLI, PDF).
 */

export function kpiSourceKindLabel(gt: Gt, kind: KpiSourceKind): string {
  switch (kind) {
    case "cost_report":
      return gt("Saved report");
    case "budget":
      return gt("Budget");
    case "commitments":
      return gt("Commitments");
    case "realized_savings":
      return gt("Realized savings");
  }
}

export function kpiReportMeasureLabel(gt: Gt, measure: KpiReportMeasure): string {
  switch (measure) {
    case "cost":
      return gt("Spend");
    case "usage":
      return gt("Usage");
    case "count":
      return gt("Distinct count");
    case "unit_cost":
      return gt("Unit cost");
    case "business_metric":
      return gt("Business metric");
  }
}

export function kpiAggregationLabel(gt: Gt, aggregation: KpiAggregation): string {
  return aggregation === "sum" ? gt("Total") : gt("Daily average");
}

export function kpiBudgetMeasureLabel(gt: Gt, measure: KpiBudgetMeasure): string {
  switch (measure) {
    case "actual":
      return gt("Spent this period");
    case "forecast":
      return gt("Projected at period end");
    case "remaining":
      return gt("Remaining");
    case "percent_used":
      return gt("Percent used");
  }
}

export function kpiCommitmentMeasureLabel(gt: Gt, measure: KpiCommitmentMeasure): string {
  switch (measure) {
    case "coverage":
      return gt("Coverage");
    case "utilization":
      return gt("Utilization");
    case "savings":
      return gt("Savings");
  }
}

/** What the big number is, in a few words: "Spend, daily average", "Budget remaining". */
export function kpiMeasureSummary(gt: Gt, config: KpiWidgetConfig): string {
  const source = config.source;
  switch (source.kind) {
    case "cost_report": {
      const measure = kpiReportMeasureLabel(gt, source.measure);
      return source.aggregation === "daily_average"
        ? gt("{measure}, daily average", { measure })
        : measure;
    }
    case "budget":
      return kpiBudgetMeasureLabel(gt, source.measure);
    case "commitments":
      return gt("Commitment {measure}", {
        measure: kpiCommitmentMeasureLabel(gt, source.measure).toLowerCase(),
      });
    case "realized_savings":
      return source.eventKind
        ? gt("Realized savings: {kind}", { kind: savingsKindLabel(gt, source.eventKind) })
        : gt("Realized savings");
  }
}
