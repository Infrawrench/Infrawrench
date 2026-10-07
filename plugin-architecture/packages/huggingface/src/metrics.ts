import type { MetricSeries } from "@infrawrench/plugin-base";
import type { AllGraphs, DataPoint, HardwareSeries } from "./wire.js";

function points(data: DataPoint[] | undefined): Array<{ timestamp: number; value: number }> {
  return (data ?? [])
    .map((p) => ({ timestamp: Date.parse(String(p.x ?? "")), value: Number(p.y) }))
    .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value));
}

function shortReplica(id: string | undefined): string {
  if (!id) return "replica";
  // Replica ids are pod names; the trailing hash is what tells them apart.
  const parts = id.split("-");
  return parts.length > 2 ? parts.slice(-2).join("-") : id;
}

function perReplica(
  label: string,
  series: HardwareSeries[] | undefined,
  unit?: string,
): MetricSeries[] {
  const out: MetricSeries[] = [];
  for (const s of series ?? []) {
    const pts = points(s.data);
    if (pts.length === 0) continue;
    const device = typeof s.deviceId === "number" ? ` GPU ${s.deviceId}` : "";
    out.push({
      label: `${label} (${shortReplica(s.replicaId)}${device})`,
      ...(unit ? { unit } : {}),
      points: pts,
    });
  }
  return out;
}

/**
 * Flatten the `POST …/metrics` response (`AllGraphs` in the Inference
 * Endpoints spec) into chart series. Units are only stated where the console
 * states them; hardware utilisation arrives without one.
 */
export function endpointMetricSeries(graphs: AllGraphs): MetricSeries[] {
  const out: MetricSeries[] = [];
  for (const s of graphs.responseStatusCodeGrouped?.series ?? []) {
    const pts = points(s.data);
    if (pts.length)
      out.push({ label: `Requests (${s.statusCode ?? "?"})`, unit: "requests", points: pts });
  }
  for (const s of graphs.responseElapsed?.series ?? []) {
    const pts = points(s.data);
    if (pts.length)
      out.push({ label: `Response time ${s.percentile ?? ""}`.trim(), unit: "ms", points: pts });
  }
  for (const s of graphs.pendingRequest?.series ?? []) {
    const pts = points(s.data);
    if (pts.length)
      out.push({ label: `Pending requests (${s.status ?? "all"})`, unit: "requests", points: pts });
  }
  for (const s of graphs.replicasRunning?.series ?? []) {
    const pts = points(s.data);
    if (pts.length)
      out.push({ label: `Replicas (${s.status ?? "running"})`, unit: "replicas", points: pts });
  }
  out.push(...perReplica("CPU", graphs.hardwareCpu?.series));
  out.push(...perReplica("Memory", graphs.hardwareMem?.series));
  out.push(...perReplica("GPU", graphs.hardwareGpu?.series));
  out.push(...perReplica("GPU memory", graphs.hardwareGpuMem?.series));
  const inf = graphs.inference;
  if (inf) {
    out.push(...perReplica("KV cache usage", inf.kvCache?.series));
    out.push(...perReplica("Prefix cache hit ratio", inf.prefixCache?.series));
    out.push(...perReplica("Time to first token", inf.ttft?.series));
    out.push(...perReplica("Inter-token latency", inf.itl?.series));
    out.push(...perReplica("Requests waiting", inf.requests?.waiting?.series, "requests"));
    out.push(...perReplica("Requests running", inf.requests?.running?.series, "requests"));
  }
  return out;
}
