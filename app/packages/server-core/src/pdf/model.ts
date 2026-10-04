/**
 * The document model a dashboard or cost-report PDF is described in.
 *
 * Deliberately chart-library-free and data-source-free: the web app's
 * renderer (`web/src/services/dashboard-pdf.ts`) turns widgets into these
 * blocks, and `render.ts` lays them out. Keeping the two halves apart is what
 * lets the layout be unit-tested with literal data, and lets a new widget kind
 * cost a mapping function rather than a new drawing routine.
 */

/** How values on an axis, in a tile or in a table cell are formatted. */
export interface PdfValueFormat {
  /** ISO currency code: values render as money. */
  currency?: string | undefined;
  /** Plain unit suffix ("ms", "GB", "%") when not money. */
  unit?: string | undefined;
}

export interface PdfChartSeries {
  label: string;
  /** One value per category; null is a gap. */
  values: Array<number | null>;
  /** Overrides the categorical colour (the "Other" grey, the forecast blue). */
  color?: string | undefined;
  /** Drawn dashed: forecasts, previous-period comparisons. */
  dashed?: boolean | undefined;
  /**
   * An overlay drawn as a line over a bar chart (forecast, comparison)
   * rather than as one more stacked bar.
   */
  overlay?: boolean | undefined;
}

export type PdfBlock =
  | {
      kind: "chart";
      chartType: "line" | "area" | "stacked_bar" | "multi_bar";
      /** X-axis labels, one per value in every series. */
      categories: string[];
      series: PdfChartSeries[];
      format: PdfValueFormat;
    }
  | {
      kind: "pie";
      slices: Array<{ label: string; value: number; color?: string | undefined }>;
      format: PdfValueFormat;
    }
  | {
      kind: "stats";
      items: Array<{
        label: string;
        value: string;
        caption?: string | undefined;
        tone?: "default" | "good" | "bad" | undefined;
      }>;
    }
  | {
      kind: "table";
      columns: string[];
      rows: Array<Array<string>>;
      /** Per-column alignment; numbers read best right-aligned. */
      align?: Array<"left" | "right"> | undefined;
    }
  | {
      /** A budget: spend against an amount, with threshold ticks. */
      kind: "progress";
      label: string;
      value: number;
      max: number;
      /** A projected end-of-period value, drawn as a lighter extension. */
      projected?: number | undefined;
      markers?: Array<{ at: number; label: string }> | undefined;
      caption?: string | undefined;
      format: PdfValueFormat;
    }
  | {
      kind: "text";
      text: string;
      tone?: "default" | "muted" | "danger" | undefined;
    };

/** One card of the source dashboard, or the single chart of a report. */
export interface PdfSection {
  title: string;
  /** A short description line under the title: window, grouping, basis. */
  subtitle?: string | undefined;
  blocks: PdfBlock[];
}

export interface PdfReportModel {
  title: string;
  /** Under the title: description, or the window the document covers. */
  subtitle?: string | undefined;
  /** Org display name, for the header and the document metadata. */
  orgName?: string | undefined;
  /** "Open in Infrawrench" deep link; null when APP_URL is unset. */
  url?: string | null | undefined;
  /** Notes under the header: currency conversion caveats and the like. */
  notes?: string[] | undefined;
  sections: PdfSection[];
  generatedAt: Date;
  /** IANA zone the generated-at line is written in; UTC when absent. */
  timezone?: string | undefined;
}
