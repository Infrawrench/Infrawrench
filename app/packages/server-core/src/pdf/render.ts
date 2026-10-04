/**
 * Lay a {@link PdfReportModel} out onto A4 pages.
 *
 * One column, top to bottom: a header (title, subtitle, org and generation
 * time, an "Open in Infrawrench" link), then one section per dashboard card.
 * A section never starts in the bottom sliver of a page, and a block that
 * does not fit what is left moves to the next page whole; a chart split
 * across a page break is unreadable. Every page gets a footer with the
 * document title and "page n of N".
 *
 * Charts are drawn for paper, not for the dark app theme: white ground, grey
 * gridlines, the same categorical rotation the app's charts use
 * (`SERIES_COLORS`), "Other" in the shared neutral grey, forecasts dashed.
 */
import { OTHER_SERIES_COLOR, SERIES_COLORS } from "@infrawrench/client-core";
import { textWidth, truncateText, wrapText, type PdfFontName } from "./fonts";
import type { PdfBlock, PdfReportModel, PdfValueFormat } from "./model";
import { A4, PdfDocument, type PdfPage } from "./writer";

const MARGIN = 40;
const CONTENT_WIDTH = A4.width - MARGIN * 2;
const FOOTER_HEIGHT = 28;
const PAGE_BOTTOM = A4.height - MARGIN - FOOTER_HEIGHT;

const INK = "#111827";
const MUTED = "#6b7280";
const FAINT = "#9ca3af";
const GRID = "#e5e7eb";
const AXIS = "#d1d5db";
const DANGER = "#dc2626";
const GOOD = "#059669";
const LINK = "#2563eb";
const PANEL = "#f9fafb";

/** Height reserved for a chart's plot area plus axes. */
const CHART_HEIGHT = 190;

/** Format a value for a tick, a tile or a tooltip-like label. */
export function formatPdfValue(value: number, format: PdfValueFormat, compact = false): string {
  if (!Number.isFinite(value)) return "-";
  if (format.currency) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: format.currency,
        ...(compact
          ? { notation: "compact", maximumFractionDigits: 1 }
          : { maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2 }),
      }).format(value);
    } catch {
      // An unknown code (a provider's own credit unit) still reads.
      return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)} ${format.currency}`;
    }
  }
  const n = new Intl.NumberFormat("en-US", {
    ...(compact ? { notation: "compact" } : {}),
    maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2,
  }).format(value);
  if (!format.unit) return n;
  return format.unit === "%" ? `${n}%` : `${n} ${format.unit}`;
}

/** "Nice" axis ticks (1, 2, 2.5, 5 × 10^n steps) covering [0, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max === min) {
    if (max === 0) return [0, 1];
    return max > 0 ? [0, max] : [max, 0];
  }
  const span = max - min;
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

function seriesColor(index: number, label: string, override?: string): string {
  if (override) return override;
  if (label === "Other") return OTHER_SERIES_COLOR;
  return SERIES_COLORS[index % SERIES_COLORS.length] ?? OTHER_SERIES_COLOR;
}

/** Cursor over the document: current page and y position. */
class Layout {
  page: PdfPage;
  y = MARGIN;

  constructor(readonly doc: PdfDocument) {
    this.page = doc.addPage();
  }

  newPage(): void {
    this.page = this.doc.addPage();
    this.y = MARGIN;
  }

  /** Move to a new page unless `height` points still fit on this one. */
  ensure(height: number): void {
    if (this.y + height > PAGE_BOTTOM && this.y > MARGIN + 1) this.newPage();
  }

  textLines(
    lines: string[],
    opts: { size: number; font?: PdfFontName; color?: string; x?: number; lineGap?: number },
  ): void {
    const lineHeight = opts.size * (opts.lineGap ?? 1.35);
    for (const line of lines) {
      this.ensure(lineHeight);
      this.page.text(opts.x ?? MARGIN, this.y, line, {
        size: opts.size,
        font: opts.font ?? "regular",
        color: opts.color ?? INK,
      });
      this.y += lineHeight;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Blocks
 * ------------------------------------------------------------------ */

function legendHeight(labels: string[], width: number): number {
  let rows = 1;
  let x = 0;
  for (const label of labels) {
    const w = 14 + Math.min(textWidth(label, 7.5), 150) + 12;
    if (x + w > width && x > 0) {
      rows++;
      x = 0;
    }
    x += w;
  }
  return rows * 12;
}

function drawLegend(
  page: PdfPage,
  x0: number,
  top: number,
  width: number,
  entries: Array<{ label: string; color: string; dashed?: boolean | undefined }>,
): void {
  let x = x0;
  let y = top;
  for (const entry of entries) {
    const label = truncateText(entry.label, 150, 7.5);
    const w = 14 + textWidth(label, 7.5) + 12;
    if (x + w > x0 + width && x > x0) {
      x = x0;
      y += 12;
    }
    if (entry.dashed) {
      page.line(x, y + 4, x + 10, y + 4, { stroke: entry.color, lineWidth: 1.5, dash: [2, 1.5] });
    } else {
      page.rect(x, y, 8, 8, { fill: entry.color });
    }
    page.text(x + 14, y, label, { size: 7.5, color: MUTED });
    x += w;
  }
}

function chartHeight(block: Extract<PdfBlock, { kind: "chart" }>): number {
  return (
    CHART_HEIGHT +
    20 +
    legendHeight(
      block.series.map((s) => s.label),
      CONTENT_WIDTH,
    )
  );
}

function drawChart(layout: Layout, block: Extract<PdfBlock, { kind: "chart" }>): void {
  const page = layout.page;
  const top = layout.y;
  const n = block.categories.length;
  if (n === 0 || block.series.length === 0) {
    drawText(layout, { kind: "text", text: "No data in this window.", tone: "muted" });
    return;
  }

  const stacked = block.chartType === "stacked_bar" || block.chartType === "area";
  const base = block.series.filter((s) => !s.overlay);
  const overlays = block.series.filter((s) => s.overlay);

  // Value range: stacked charts are bounded by per-category sums.
  let maxV = 0;
  let minV = 0;
  for (let i = 0; i < n; i++) {
    if (stacked) {
      let pos = 0;
      let neg = 0;
      for (const s of base) {
        const v = s.values[i] ?? 0;
        if (v >= 0) pos += v;
        else neg += v;
      }
      maxV = Math.max(maxV, pos);
      minV = Math.min(minV, neg);
    } else {
      for (const s of base) {
        const v = s.values[i];
        if (v !== null && v !== undefined) {
          maxV = Math.max(maxV, v);
          minV = Math.min(minV, v);
        }
      }
    }
    for (const s of overlays) {
      const v = s.values[i];
      if (v !== null && v !== undefined) {
        maxV = Math.max(maxV, v);
        minV = Math.min(minV, v);
      }
    }
  }
  const ticks = niceTicks(minV, maxV);
  const lo = ticks[0] ?? 0;
  const hi = ticks[ticks.length - 1] ?? 1;

  const tickLabels = ticks.map((t) => formatPdfValue(t, block.format, true));
  const axisWidth = Math.max(...tickLabels.map((l) => textWidth(l, 7))) + 6;
  const plotX = MARGIN + axisWidth;
  const plotW = CONTENT_WIDTH - axisWidth;
  const plotTop = top + 4;
  const plotH = CHART_HEIGHT - 22;
  const yOf = (v: number) => plotTop + plotH - ((v - lo) / (hi - lo || 1)) * plotH;

  ticks.forEach((t, i) => {
    const y = yOf(t);
    page.line(plotX, y, plotX + plotW, y, { stroke: t === 0 ? AXIS : GRID, lineWidth: 0.5 });
    const label = tickLabels[i] ?? "";
    page.text(plotX - 4 - textWidth(label, 7), y - 3.5, label, { size: 7, color: FAINT });
  });

  const slot = plotW / n;
  const xCenter = (i: number) => plotX + slot * i + slot / 2;

  // X labels: at most ~10, evenly spaced, always including the last.
  const labelEvery = Math.max(1, Math.ceil(n / 10));
  for (let i = 0; i < n; i++) {
    if (i % labelEvery !== 0 && i !== n - 1) continue;
    if (i !== n - 1 && n - 1 - i < labelEvery && n > labelEvery) continue;
    const label = truncateText(block.categories[i] ?? "", Math.max(slot * labelEvery - 4, 24), 7);
    const w = textWidth(label, 7);
    page.text(
      Math.min(Math.max(xCenter(i) - w / 2, plotX), plotX + plotW - w),
      plotTop + plotH + 5,
      label,
      { size: 7, color: FAINT },
    );
  }

  const colors = block.series.map((s, i) => seriesColor(i, s.label, s.color));
  const colorOf = (s: (typeof block.series)[number]) => colors[block.series.indexOf(s)] ?? INK;

  if (block.chartType === "stacked_bar" || block.chartType === "multi_bar") {
    const barGap = Math.min(slot * 0.2, 6);
    for (let i = 0; i < n; i++) {
      const x0 = plotX + slot * i + barGap / 2;
      const w = slot - barGap;
      if (block.chartType === "stacked_bar") {
        let pos = 0;
        let neg = 0;
        for (const s of base) {
          const v = s.values[i] ?? 0;
          if (v === 0) continue;
          const from = v >= 0 ? pos : neg;
          const to = from + v;
          if (v >= 0) pos = to;
          else neg = to;
          const yTop = yOf(Math.max(from, to));
          const yBottom = yOf(Math.min(from, to));
          page.rect(x0, yTop, w, Math.max(yBottom - yTop, 0.3), { fill: colorOf(s) });
        }
      } else {
        const bw = w / Math.max(1, base.length);
        base.forEach((s, k) => {
          const v = s.values[i];
          if (v === null || v === undefined || v === 0) return;
          const y0 = yOf(Math.max(0, v));
          const y1 = yOf(Math.min(0, v));
          page.rect(x0 + bw * k, y0, Math.max(bw - 0.5, 0.3), Math.max(y1 - y0, 0.3), {
            fill: colorOf(s),
          });
        });
      }
    }
  } else if (block.chartType === "area") {
    const cumulative = new Array<number>(n).fill(0);
    for (const s of base) {
      const lower = [...cumulative];
      const upper = lower.map((l, i) => l + (s.values[i] ?? 0));
      const points: Array<[number, number]> = [];
      for (let i = 0; i < n; i++) points.push([xCenter(i), yOf(upper[i]!)]);
      for (let i = n - 1; i >= 0; i--) points.push([xCenter(i), yOf(lower[i]!)]);
      const color = colorOf(s);
      page.polygon(points, { fill: blend(color, 0.55) });
      page.polyline(points.slice(0, n), { stroke: color, lineWidth: 1 });
      for (let i = 0; i < n; i++) cumulative[i] = upper[i]!;
    }
  } else {
    for (const s of base) drawLine(page, s, n, xCenter, yOf, colorOf(s));
  }
  for (const s of overlays) drawLine(page, s, n, xCenter, yOf, colorOf(s));

  drawLegend(
    page,
    MARGIN,
    top + CHART_HEIGHT,
    CONTENT_WIDTH,
    block.series.map((s) => ({ label: s.label, color: colorOf(s), dashed: s.dashed })),
  );
  layout.y = top + chartHeight(block);
}

function drawLine(
  page: PdfPage,
  s: { values: Array<number | null>; dashed?: boolean | undefined },
  n: number,
  xCenter: (i: number) => number,
  yOf: (v: number) => number,
  color: string,
): void {
  // Split on nulls: a gap is a gap, not a line to zero.
  let run: Array<[number, number]> = [];
  const flush = () => {
    if (run.length === 1) {
      const [x, y] = run[0]!;
      page.rect(x - 1.2, y - 1.2, 2.4, 2.4, { fill: color });
    } else if (run.length > 1) {
      page.polyline(run, { stroke: color, lineWidth: 1.5, dash: s.dashed ? [3, 2] : undefined });
    }
    run = [];
  };
  for (let i = 0; i < n; i++) {
    const v = s.values[i];
    if (v === null || v === undefined) flush();
    else run.push([xCenter(i), yOf(v)]);
  }
  flush();
}

/** `color` mixed toward white by `amount` (0 = unchanged, 1 = white). */
function blend(color: string, amount: number): string {
  const hex = color.replace("#", "");
  const ch = (i: number) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16);
    return Math.round(v + (255 - v) * amount)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${ch(0)}${ch(2)}${ch(4)}`;
}

const PIE_HEIGHT = 170;

function drawPie(layout: Layout, block: Extract<PdfBlock, { kind: "pie" }>): void {
  const page = layout.page;
  const slices = block.slices.filter((s) => s.value > 0);
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) {
    drawText(layout, { kind: "text", text: "No data in this window.", tone: "muted" });
    return;
  }
  const r = 70;
  const cx = MARGIN + r + 10;
  const cy = layout.y + PIE_HEIGHT / 2;
  let angle = -Math.PI / 2;
  slices.forEach((slice, i) => {
    const sweep = (slice.value / total) * Math.PI * 2;
    const steps = Math.max(2, Math.ceil(sweep / (Math.PI / 90)));
    const points: Array<[number, number]> = [[cx, cy]];
    for (let k = 0; k <= steps; k++) {
      const a = angle + (sweep * k) / steps;
      points.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    page.polygon(points, {
      fill: seriesColor(i, slice.label, slice.color),
      stroke: "#ffffff",
      lineWidth: 0.75,
    });
    angle += sweep;
  });

  // Legend with values and shares, beside the pie.
  const lx = cx + r + 30;
  let ly = layout.y + 10;
  const maxRows = Math.floor((PIE_HEIGHT - 10) / 13);
  slices.slice(0, maxRows).forEach((slice, i) => {
    page.rect(lx, ly + 1, 8, 8, { fill: seriesColor(i, slice.label, slice.color) });
    const value = `${formatPdfValue(slice.value, block.format)}  ${((slice.value / total) * 100).toFixed(1)}%`;
    const vw = textWidth(value, 8);
    page.text(lx + 14, ly, truncateText(slice.label, CONTENT_WIDTH - (lx - MARGIN) - vw - 30, 8), {
      size: 8,
      color: INK,
    });
    page.text(MARGIN + CONTENT_WIDTH - vw, ly, value, { size: 8, color: MUTED });
    ly += 13;
  });
  if (slices.length > maxRows) {
    page.text(lx + 14, ly, `+ ${slices.length - maxRows} more`, { size: 8, color: FAINT });
  }
  layout.y += PIE_HEIGHT + 6;
}

function drawStats(layout: Layout, block: Extract<PdfBlock, { kind: "stats" }>): void {
  const perRow = Math.min(3, Math.max(1, block.items.length));
  const gap = 8;
  const w = (CONTENT_WIDTH - gap * (perRow - 1)) / perRow;
  const h = 56;
  for (let i = 0; i < block.items.length; i += perRow) {
    layout.ensure(h + gap);
    const row = block.items.slice(i, i + perRow);
    row.forEach((item, k) => {
      const x = MARGIN + k * (w + gap);
      const page = layout.page;
      page.rect(x, layout.y, w, h, { fill: PANEL, stroke: GRID, lineWidth: 0.5 });
      page.text(x + 10, layout.y + 8, truncateText(item.label, w - 20, 8), {
        size: 8,
        color: MUTED,
      });
      page.text(x + 10, layout.y + 21, truncateText(item.value, w - 20, 16, "bold"), {
        size: 16,
        font: "bold",
        color: item.tone === "bad" ? DANGER : item.tone === "good" ? GOOD : INK,
      });
      if (item.caption) {
        page.text(x + 10, layout.y + 42, truncateText(item.caption, w - 20, 7.5), {
          size: 7.5,
          color: FAINT,
        });
      }
    });
    layout.y += h + gap;
  }
}

function drawTable(layout: Layout, block: Extract<PdfBlock, { kind: "table" }>): void {
  const cols = Math.max(1, block.columns.length);
  const size = 8;
  const rowH = 15;
  // Column widths: proportional to the longest cell, first column favoured.
  const natural = block.columns.map((col, c) => {
    const cells = [col, ...block.rows.map((r) => r[c] ?? "")];
    return Math.min(
      260,
      Math.max(...cells.map((cell, i) => textWidth(cell, size, i === 0 ? "bold" : "regular"))) + 12,
    );
  });
  const sum = natural.reduce((a, b) => a + b, 0) || 1;
  const widths = natural.map((w) => (w / sum) * CONTENT_WIDTH);
  const align = (c: number) => block.align?.[c] ?? (c === 0 ? "left" : "left");

  const drawHeader = () => {
    layout.page.rect(MARGIN, layout.y, CONTENT_WIDTH, rowH, { fill: PANEL });
    let x = MARGIN;
    block.columns.forEach((col, c) => {
      const w = widths[c] ?? 0;
      const label = truncateText(col, w - 8, size, "bold");
      const tx = align(c) === "right" ? x + w - 4 - textWidth(label, size, "bold") : x + 4;
      layout.page.text(tx, layout.y + 3.5, label, { size, font: "bold", color: MUTED });
      x += w;
    });
    layout.y += rowH;
  };

  layout.ensure(rowH * 2);
  drawHeader();
  for (const row of block.rows) {
    if (layout.y + rowH > PAGE_BOTTOM) {
      layout.newPage();
      drawHeader();
    }
    let x = MARGIN;
    for (let c = 0; c < cols; c++) {
      const w = widths[c] ?? 0;
      const cell = truncateText(row[c] ?? "", w - 8, size);
      const tx = align(c) === "right" ? x + w - 4 - textWidth(cell, size) : x + 4;
      layout.page.text(tx, layout.y + 3.5, cell, { size, color: INK });
      x += w;
    }
    layout.page.line(MARGIN, layout.y + rowH, MARGIN + CONTENT_WIDTH, layout.y + rowH, {
      stroke: GRID,
      lineWidth: 0.5,
    });
    layout.y += rowH;
  }
  if (block.rows.length === 0) {
    layout.textLines(["No rows."], { size: 8, color: FAINT, x: MARGIN + 4 });
  }
  layout.y += 6;
}

function drawProgress(layout: Layout, block: Extract<PdfBlock, { kind: "progress" }>): void {
  const page = layout.page;
  const top = layout.y;
  const max = block.max > 0 ? block.max : 1;
  const scaleMax = Math.max(
    max,
    block.value,
    block.projected ?? 0,
    ...(block.markers ?? []).map((m) => m.at),
  );
  const barTop = top + 18;
  const barH = 12;
  const xOf = (v: number) => MARGIN + (Math.max(0, v) / scaleMax) * CONTENT_WIDTH;
  const over = block.value > max;
  const color = over ? DANGER : block.value / max >= 0.8 ? "#d97706" : GOOD;

  const headline = `${formatPdfValue(block.value, block.format)} of ${formatPdfValue(block.max, block.format)}`;
  page.text(MARGIN, top, truncateText(block.label, CONTENT_WIDTH - 140, 9, "bold"), {
    size: 9,
    font: "bold",
  });
  const pct = `${((block.value / max) * 100).toFixed(0)}%`;
  const right = `${headline} (${pct})`;
  page.text(MARGIN + CONTENT_WIDTH - textWidth(right, 9), top, right, {
    size: 9,
    color: over ? DANGER : INK,
  });

  page.rect(MARGIN, barTop, CONTENT_WIDTH, barH, { fill: "#f3f4f6" });
  if (block.projected !== undefined && block.projected > block.value) {
    page.rect(xOf(block.value), barTop, xOf(block.projected) - xOf(block.value), barH, {
      fill: blend(color, 0.7),
    });
  }
  page.rect(MARGIN, barTop, xOf(block.value) - MARGIN, barH, { fill: color });
  // The budget amount itself, when the bar's scale runs past it.
  if (scaleMax > max) {
    page.line(xOf(max), barTop - 3, xOf(max), barTop + barH + 3, { stroke: INK, lineWidth: 1 });
  }
  for (const marker of block.markers ?? []) {
    const x = xOf(marker.at);
    page.line(x, barTop - 2, x, barTop + barH + 2, {
      stroke: MUTED,
      lineWidth: 0.5,
      dash: [1.5, 1],
    });
    const w = textWidth(marker.label, 6.5);
    page.text(
      Math.min(Math.max(x - w / 2, MARGIN), MARGIN + CONTENT_WIDTH - w),
      barTop + barH + 4,
      marker.label,
      {
        size: 6.5,
        color: FAINT,
      },
    );
  }
  layout.y = barTop + barH + 16;
  if (block.caption) {
    layout.textLines(wrapText(block.caption, CONTENT_WIDTH, 8), { size: 8, color: MUTED });
  }
  layout.y += 4;
}

function drawText(layout: Layout, block: Extract<PdfBlock, { kind: "text" }>): void {
  const color = block.tone === "danger" ? DANGER : block.tone === "muted" ? MUTED : INK;
  layout.textLines(wrapText(block.text, CONTENT_WIDTH, 9), { size: 9, color });
  layout.y += 4;
}

/** Height a block needs, for keep-together decisions. Tables flow instead. */
function blockHeight(block: PdfBlock): number {
  switch (block.kind) {
    case "chart":
      return chartHeight(block);
    case "pie":
      return PIE_HEIGHT + 6;
    case "stats":
      return 64;
    case "table":
      return 15 * Math.min(4, block.rows.length + 1);
    case "progress":
      return 54 + (block.caption ? 12 : 0);
    case "text":
      return 16;
  }
}

function drawBlock(layout: Layout, block: PdfBlock): void {
  layout.ensure(blockHeight(block));
  switch (block.kind) {
    case "chart":
      return drawChart(layout, block);
    case "pie":
      return drawPie(layout, block);
    case "stats":
      return drawStats(layout, block);
    case "table":
      return drawTable(layout, block);
    case "progress":
      return drawProgress(layout, block);
    case "text":
      return drawText(layout, block);
  }
}

function formatGeneratedAt(date: Date, timezone: string | undefined): string {
  const tz = timezone ?? "UTC";
  try {
    return `${new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: tz,
    }).format(date)} ${tz}`;
  } catch {
    return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}

/** Render the model to PDF bytes. */
export function renderReportPdf(model: PdfReportModel): Uint8Array {
  const doc = new PdfDocument({
    title: model.title,
    ...(model.orgName ? { author: model.orgName } : {}),
    subject: "Infrawrench export",
  });
  const layout = new Layout(doc);

  // Header.
  const titleLines = wrapText(model.title, CONTENT_WIDTH, 18, "bold");
  layout.textLines(titleLines, { size: 18, font: "bold", lineGap: 1.25 });
  if (model.subtitle) {
    layout.textLines(wrapText(model.subtitle, CONTENT_WIDTH, 10), { size: 10, color: MUTED });
  }
  const meta = [model.orgName, `Generated ${formatGeneratedAt(model.generatedAt, model.timezone)}`]
    .filter(Boolean)
    .join(" · ");
  layout.textLines([meta], { size: 8, color: FAINT });
  if (model.url) {
    const label = "Open in Infrawrench";
    layout.page.text(MARGIN, layout.y, label, { size: 8, color: LINK });
    layout.page.link(MARGIN, layout.y - 1, textWidth(label, 8) + 2, 11, model.url);
    layout.y += 12;
  }
  for (const note of model.notes ?? []) {
    layout.textLines(wrapText(note, CONTENT_WIDTH, 8), { size: 8, color: MUTED });
  }
  layout.y += 6;
  layout.page.line(MARGIN, layout.y, MARGIN + CONTENT_WIDTH, layout.y, {
    stroke: GRID,
    lineWidth: 1,
  });
  layout.y += 14;

  if (model.sections.length === 0) {
    drawText(layout, { kind: "text", text: "This dashboard has no cards yet.", tone: "muted" });
  }

  for (const section of model.sections) {
    // A section heading never sits alone at the bottom of a page.
    const first = section.blocks[0];
    layout.ensure(30 + (first ? Math.min(blockHeight(first), 220) : 0));
    layout.textLines(wrapText(section.title || "Untitled", CONTENT_WIDTH, 12, "bold"), {
      size: 12,
      font: "bold",
    });
    if (section.subtitle) {
      layout.textLines(wrapText(section.subtitle, CONTENT_WIDTH, 8), { size: 8, color: MUTED });
    }
    layout.y += 4;
    for (const block of section.blocks) drawBlock(layout, block);
    layout.y += 14;
  }

  // Footers, now that the page count is known.
  const total = doc.pages.length;
  doc.pages.forEach((page, i) => {
    const y = A4.height - MARGIN + 6;
    page.line(MARGIN, y - 8, MARGIN + CONTENT_WIDTH, y - 8, { stroke: GRID, lineWidth: 0.5 });
    page.text(MARGIN, y, truncateText(`Infrawrench · ${model.title}`, CONTENT_WIDTH - 80, 7), {
      size: 7,
      color: FAINT,
    });
    const label = `Page ${i + 1} of ${total}`;
    page.text(MARGIN + CONTENT_WIDTH - textWidth(label, 7), y, label, { size: 7, color: FAINT });
  });

  return doc.toBytes(model.generatedAt);
}
