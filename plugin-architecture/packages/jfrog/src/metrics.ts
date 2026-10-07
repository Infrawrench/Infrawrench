import type { MetricSeries } from "@infrawrench/plugin-base";
import type { JfrogRepoStorage, JfrogStorageInfo } from "./mappers.js";
import { parsePercent, parseSize } from "./mappers.js";

/**
 * Artifactory publishes storage as a snapshot (`GET /api/storageinfo`), not a
 * history, so every series here is one point stamped "now". The host keeps
 * the readings it collects, which is what turns them into a trend.
 */
function point(label: string, unit: string, value: number | undefined, now: number) {
  return value === undefined ? undefined : { label, unit, points: [{ timestamp: now, value }] };
}

function present(series: Array<MetricSeries | undefined>): MetricSeries[] {
  return series.filter((s): s is MetricSeries => s !== undefined);
}

export function platformSeries(storage: JfrogStorageInfo, now = Date.now()): MetricSeries[] {
  const b = storage.binariesSummary;
  const fs = storage.fileStoreSummary;
  return present([
    point("Binaries size", "bytes", parseSize(b?.binariesSize), now),
    point("Artifacts size", "bytes", parseSize(b?.artifactsSize), now),
    point("Artifacts", "count", parseSize(b?.artifactsCount), now),
    point("Binaries", "count", parseSize(b?.binariesCount), now),
    point("Items", "count", parseSize(b?.itemsCount), now),
    point("File store used", "bytes", parseSize(fs?.usedSpace), now),
    point("File store used", "%", parsePercent(fs?.usedSpace), now),
    point("Deduplication savings", "%", parsePercent(b?.optimization), now),
  ]);
}

export function repositorySeries(row: JfrogRepoStorage, now = Date.now()): MetricSeries[] {
  return present([
    point("Used space", "bytes", row.usedSpaceInBytes ?? parseSize(row.usedSpace), now),
    point("Files", "count", row.filesCount, now),
    point("Folders", "count", row.foldersCount, now),
    point("Items", "count", row.itemsCount, now),
    point("Share of storage", "%", parsePercent(row.percentage), now),
  ]);
}
