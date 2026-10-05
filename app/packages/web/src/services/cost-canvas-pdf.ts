/**
 * Cost canvas PDFs and the canvas delivery renderer.
 *
 * A canvas is run (`runCostCanvas`, every query re-executed) and each block
 * result mapped onto the shared PDF block model, reusing the dashboard
 * mappers so a chart on a canvas prints exactly like the same chart on a
 * dashboard.
 */
import {
  COST_ANOMALY_DIMENSION_LABELS,
  formatBucketLabel,
  formatCostCanvasChange,
  formatCostCanvasKpi,
  type CostCanvasBlock,
  type CostCanvasBlockResult,
  type CostCanvasSpec,
  type CostGraphConfig,
} from "@infrawrench/client-core";
import {
  formatPdfValue,
  renderReportPdf,
  type PdfBlock,
  type PdfReportModel,
  type PdfSection,
} from "@infrawrench/server-core/pdf";
import { orgAppUrl } from "@infrawrench/server-core/app-url";
import { resolveObjectCostVisibility } from "@infrawrench/server-core/cost/visibility";
import { runWithCostVisibility } from "@infrawrench/server-core/cost/visibility-context";
import type { CanvasRenderRequest } from "@infrawrench/server-core/report-delivery/canvas";
import type { RenderedDashboard } from "@infrawrench/server-core/report-delivery/dashboard";
import { getCostCanvas, runCostCanvasSpec } from "./cost-canvases";
import {
  costResponseBlocks,
  customChartBlocks,
  describeConfig,
  orgName,
  unitCostResponseBlocks,
} from "./dashboard-pdf";

interface BuiltCanvas {
  name: string;
  description: string | null;
  sections: PdfSection[];
  highlights: string[];
  url: string | null;
}

function chartSection(
  title: string,
  config: CostGraphConfig,
  r: { from?: string | undefined; to?: string | undefined; cost?: unknown; unitCost?: unknown },
): { section: PdfSection; highlight: string | null } {
  const subtitle = r.from && r.to ? describeConfig(config, r.from, r.to) : undefined;
  if (r.unitCost) {
    const { blocks } = unitCostResponseBlocks(
      r.unitCost as Parameters<typeof unitCostResponseBlocks>[0],
    );
    return { section: { title, ...(subtitle ? { subtitle } : {}), blocks }, highlight: null };
  }
  if (r.cost) {
    const { blocks, total, totalChange } = costResponseBlocks(
      config,
      r.cost as Parameters<typeof costResponseBlocks>[1],
    );
    return {
      section: { title, ...(subtitle ? { subtitle } : {}), blocks },
      highlight: total ? `${title}: ${total}${totalChange ? ` (${totalChange})` : ""}` : null,
    };
  }
  return { section: { title, blocks: [] }, highlight: null };
}

/** Map one block and its result onto PDF sections. */
function blockSections(
  block: CostCanvasBlock,
  result: CostCanvasBlockResult,
): { sections: PdfSection[]; highlights: string[] } {
  if (result.error) {
    const title = block.kind === "text" ? "Text" : ("title" in block && block.title) || block.kind;
    return {
      sections: [{ title, blocks: [{ kind: "text", text: result.error, tone: "danger" }] }],
      highlights: [],
    };
  }
  switch (result.kind) {
    case "text":
      return {
        sections: [{ title: "", blocks: [{ kind: "text", text: result.text }] }],
        highlights: [],
      };
    case "kpi": {
      const b = block as Extract<CostCanvasBlock, { kind: "kpi" }>;
      const value = formatCostCanvasKpi(result.kpi);
      const change = formatCostCanvasChange(result.kpi?.changePercent);
      return {
        sections: [
          {
            title: b.title,
            blocks: [
              {
                kind: "stats",
                items: [
                  {
                    label: b.title,
                    value,
                    ...(change || result.kpi?.note
                      ? {
                          caption: [
                            change ? `${change} vs previous period` : null,
                            result.kpi?.note,
                          ]
                            .filter(Boolean)
                            .join(". "),
                        }
                      : {}),
                  },
                ],
              },
            ],
          },
        ],
        highlights: [`${b.title}: ${value}${change ? ` (${change})` : ""}`],
      };
    }
    case "chart": {
      const b = block as Extract<CostCanvasBlock, { kind: "chart" }>;
      const { section, highlight } = chartSection(b.title, b.config, result);
      return { sections: [section], highlights: highlight ? [highlight] : [] };
    }
    case "cost_report": {
      if (!result.report) return { sections: [], highlights: [] };
      const b = block as Extract<CostCanvasBlock, { kind: "cost_report" }>;
      const { section, highlight } = chartSection(
        b.title || result.report.name,
        result.report.config,
        result,
      );
      return { sections: [section], highlights: highlight ? [highlight] : [] };
    }
    case "table": {
      const b = block as Extract<CostCanvasBlock, { kind: "table" }>;
      const t = result.table;
      if (!t) return { sections: [], highlights: [] };
      const binning = b.query.binning === "none" ? "monthly" : b.query.binning;
      const format = t.currency ? { currency: t.currency } : {};
      const columns = [
        "",
        ...(b.query.binning === "none" ? [] : t.columns.map((c) => formatBucketLabel(c, binning))),
        "Total",
      ];
      const rows = t.rows.map((r) => [
        r.label,
        ...(b.query.binning === "none" ? [] : r.values.map((v) => formatPdfValue(v, format))),
        formatPdfValue(r.total, format),
      ]);
      const blocks: PdfBlock[] = [
        {
          kind: "table",
          columns,
          rows,
          align: columns.map((_, i) => (i === 0 ? "left" : "right")),
        },
      ];
      if (t.otherCurrencies.length > 0) {
        blocks.push({
          kind: "text",
          text: `Spend in ${t.otherCurrencies.join(", ")} is not included in this table.`,
          tone: "muted",
        });
      }
      return {
        sections: [{ title: b.title, subtitle: `${t.from} to ${t.to}`, blocks }],
        highlights: [],
      };
    }
    case "budgets": {
      const b = block as Extract<CostCanvasBlock, { kind: "budgets" }>;
      const blocks: PdfBlock[] = result.budgets.map((budget) => ({
        kind: "progress",
        label: budget.name,
        value: budget.actualCents / 100,
        max: budget.amountCents / 100,
        ...(budget.forecastCents !== null && budget.forecastCents !== undefined
          ? { projected: budget.forecastCents / 100 }
          : {}),
        markers: budget.thresholds.map((t) => ({
          at: (budget.amountCents * t.percent) / 10_000,
          label: `${t.percent}%`,
        })),
        format: { currency: budget.currency },
      }));
      if (blocks.length === 0)
        blocks.push({ kind: "text", text: "No budgets to show.", tone: "muted" });
      return { sections: [{ title: b.title, blocks }], highlights: [] };
    }
    case "anomalies": {
      const b = block as Extract<CostCanvasBlock, { kind: "anomalies" }>;
      const blocks: PdfBlock[] = result.withheld
        ? [
            {
              kind: "text",
              text: "Anomalies are detected over all of the org's spend and are not shown to scoped viewers.",
              tone: "muted",
            },
          ]
        : result.anomalies.length === 0
          ? [{ kind: "text", text: "No anomalies in this window.", tone: "muted" }]
          : [
              {
                kind: "table",
                columns: ["Day", "Where", "Spend", "Usual"],
                rows: result.anomalies.map((a) => [
                  a.day,
                  `${COST_ANOMALY_DIMENSION_LABELS[a.dimension] ?? a.dimension}: ${a.dimensionKey}`,
                  formatPdfValue(a.actualCents / 100, { currency: a.currency }),
                  a.kind === "new_source"
                    ? "none"
                    : formatPdfValue(a.baselineCents / 100, { currency: a.currency }),
                ]),
                align: ["left", "left", "right", "right"],
              },
            ];
      return {
        sections: [{ title: b.title, subtitle: `Last ${b.days} days`, blocks }],
        highlights: result.withheld ? [] : [`${b.title}: ${result.anomalies.length}`],
      };
    }
    case "custom_graph": {
      const b = block as Extract<CostCanvasBlock, { kind: "custom_graph" }>;
      const title = b.title || result.graph?.name || "Custom graph";
      if (!result.spec) return { sections: [{ title, blocks: [] }], highlights: [] };
      const blocks = customChartBlocks(result.spec.chart);
      if (result.spec.notice)
        blocks.push({ kind: "text", text: result.spec.notice, tone: "muted" });
      return { sections: [{ title, blocks }], highlights: [] };
    }
  }
}

/** Run a canvas and map it to PDF sections. Null when the canvas is gone. */
export async function canvasPdfSections(
  organizationId: string,
  canvasId: string,
  opts: { granted: readonly string[] | null; now?: Date | undefined },
): Promise<BuiltCanvas | null> {
  const canvas = await getCostCanvas(organizationId, canvasId, null);
  if (!canvas) return null;
  const run = await runCostCanvasSpec(
    organizationId,
    { id: canvas.id, name: canvas.name, spec: canvas.spec as CostCanvasSpec },
    { granted: opts.granted, includeChartData: true, now: opts.now },
  );
  const sections: PdfSection[] = [];
  const highlights: string[] = [];
  canvas.spec.blocks.forEach((block, i) => {
    const result = run.blocks[i];
    if (!result) return;
    const out = blockSections(block, result);
    // Consecutive narrative and KPI blocks read best gathered: fold a text
    // section with no title into the previous section when there is one.
    for (const sec of out.sections) {
      const prev = sections[sections.length - 1];
      if (sec.title === "" && prev) prev.blocks.push(...sec.blocks);
      else sections.push(sec.title === "" ? { ...sec, title: canvas.name } : sec);
    }
    highlights.push(...out.highlights);
  });
  return {
    name: canvas.name,
    description: canvas.description,
    sections,
    highlights,
    url: orgAppUrl(organizationId, `cost-canvases/${canvas.id}`),
  };
}

function modelFor(
  organizationId: string,
  built: BuiltCanvas,
  org: string | undefined,
  now: Date,
  timezone: string | undefined,
): PdfReportModel {
  void organizationId;
  return {
    title: built.name,
    subtitle: built.description ?? "Canvas",
    ...(org ? { orgName: org } : {}),
    url: built.url,
    sections: built.sections,
    generatedAt: now,
    ...(timezone ? { timezone } : {}),
  };
}

/** Render a canvas to PDF for a reader with `granted` permissions. */
export async function renderCostCanvasPdf(
  organizationId: string,
  canvasId: string,
  opts: { granted: readonly string[]; timezone?: string | undefined; now?: Date | undefined },
): Promise<{ name: string; pdf: Uint8Array } | null> {
  const now = opts.now ?? new Date();
  const [built, org] = await Promise.all([
    canvasPdfSections(organizationId, canvasId, { granted: opts.granted, now }),
    orgName(organizationId),
  ]);
  if (!built) return null;
  return {
    name: built.name,
    pdf: renderReportPdf(modelFor(organizationId, built, org, now, opts.timezone)),
  };
}

/**
 * The {@link CanvasRenderer} the delivery loop and "Send now" use. Runs inside
 * the scoped creator's cost visibility, so a schedule never ships more than
 * the person who created it could see.
 */
export async function renderCanvasForDelivery(
  req: CanvasRenderRequest,
): Promise<RenderedDashboard | null> {
  const visibility = await resolveObjectCostVisibility(req.organizationId, req.visibilityUserId);
  return runWithCostVisibility(visibility, async () => {
    const [built, org] = await Promise.all([
      canvasPdfSections(req.organizationId, req.costCanvasId, { granted: null, now: req.now }),
      orgName(req.organizationId),
    ]);
    if (!built) return null;
    return {
      name: built.name,
      pdf: req.includePdf
        ? renderReportPdf(modelFor(req.organizationId, built, org, req.now, req.timezone))
        : null,
      highlights: built.highlights,
      url: built.url,
    };
  });
}
