/**
 * Ad-hoc FOCUS 1.3 download: the rows a cost query selects, written in the
 * same FOCUS layout a `focus-1.3` scheduled export writes.
 *
 * Shared by the HTTP route (which the web app, the desktop app and the CLI all
 * call) so the filter resolution, the range bound and the column mapping are
 * one implementation. The mapping itself lives in
 * `server-core/src/cost-exports/focus.ts`, which the poller's scheduled runs
 * use too: a downloaded file and an exported object over the same days are the
 * same bytes apart from `x_ExportedAt`.
 */
import { FOCUS_EXPORT_MAX_DAYS, type FocusExportRequest } from "@infrawrench/client-core";
export { focusExportFilename } from "@infrawrench/client-core";
import {
  loadFocusLookups,
  mapFocusRows,
  streamFocusSourceRows,
  toFocusCsv,
} from "@infrawrench/server-core/cost-exports/focus";
import { costCollectionWatermark } from "@infrawrench/server-core/cost-exports/run";
import { CostQueryError, daySpan, resolveCostRequestFilters } from "./cost-query";

/**
 * Validate the request and return the CSV as a stream of chunks.
 *
 * Throws {@link CostQueryError} for anything the caller got wrong, before a
 * single byte is produced, so the route can still answer 400 rather than a
 * truncated 200. Everything after that point is streamed: a year of
 * per-resource rows is far too large to build as one string.
 */
export async function streamFocusExport(
  organizationId: string,
  req: FocusExportRequest,
  now = new Date(),
): Promise<AsyncIterable<string>> {
  if (req.from > req.to) throw new CostQueryError("from must not be after to");
  const span = daySpan(req.from, req.to);
  if (span > FOCUS_EXPORT_MAX_DAYS) {
    throw new CostQueryError(
      `A FOCUS download spans at most ${FOCUS_EXPORT_MAX_DAYS} days; this one spans ${span}. ` +
        "Download it in pieces, or set up a scheduled export, which writes one file per period.",
    );
  }

  const filters = await resolveCostRequestFilters(organizationId, {
    filters: req.filters ?? [],
    query: req.query,
    savedFilterId: req.savedFilterId,
  });

  const [lookups, watermark] = await Promise.all([
    loadFocusLookups(organizationId),
    costCollectionWatermark(organizationId),
  ]);

  const rows = mapFocusRows(
    streamFocusSourceRows({
      organizationId,
      from: req.from,
      to: req.to,
      filters,
      chargeTypes: req.chargeTypes,
    }),
    lookups,
    { exportedAt: now.toISOString(), collectionWatermark: watermark },
  );
  return toFocusCsv(rows);
}
