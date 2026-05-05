export const METRIC_PINGS_CHANGED_EVENT = "iw:metric-pings-changed";

export function notifyMetricPingsChanged() {
  window.dispatchEvent(new CustomEvent(METRIC_PINGS_CHANGED_EVENT));
}
