/**
 * The time range a resource's Metrics tab asks the server for.
 *
 * The chart's caption ("Last 12 h", "Last 720 h") comes from the rendered
 * detail's `metricsCapability.defaultTimeRangeMs`: the window the plugin's own
 * `fetchMetricSeries` uses when it is asked without a range. Desktop local
 * mode calls the plugin directly with no range, so it gets that window. The
 * cloud route (`POST /resources/:pluginId/:typeId/metrics`) reads recorded
 * history first and so needs bounds; with none in the request it falls back
 * to the last hour. A client that sends nothing therefore draws an hour under
 * a caption naming the plugin's window.
 *
 * So a cloud client sends the declared window explicitly. A view that declares
 * none (an instantaneous snapshot, or a peer-only type whose window belongs to
 * the peer) sends no range and keeps the route's own default.
 *
 * Takes the number rather than the schema so callers can key their effects on
 * it; client-core takes no runtime dependency on plugin-base anyway.
 */
export function metricsRequestRange(
  defaultTimeRangeMs: number | undefined,
  nowMs: number = Date.now(),
): { startMs?: number; endMs?: number } {
  if (
    defaultTimeRangeMs === undefined ||
    !Number.isFinite(defaultTimeRangeMs) ||
    defaultTimeRangeMs <= 0
  ) {
    return {};
  }
  return { startMs: nowMs - defaultTimeRangeMs, endMs: nowMs };
}
