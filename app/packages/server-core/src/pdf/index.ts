/**
 * Server-side PDF rendering for dashboard and cost-report exports. See
 * `writer.ts` for why this is hand-rolled, `model.ts` for the document model
 * and `render.ts` for the layout.
 */
export type { PdfBlock, PdfChartSeries, PdfReportModel, PdfSection, PdfValueFormat } from "./model";
export { formatPdfValue, niceTicks, renderReportPdf } from "./render";
export { textWidth, toWinAnsi, truncateText, wrapText } from "./fonts";
export { A4, PdfDocument, PdfPage } from "./writer";
