/**
 * GPU utilization: whether the GPUs workloads asked for are actually busy.
 *
 * `metrics.k8s.io` carries CPU and memory and nothing else, so GPU usage has
 * to come from NVIDIA's DCGM exporter (deployed by the GPU operator as the
 * `nvidia-dcgm-exporter` DaemonSet, port 9400) or AMD's device metrics
 * exporter. Two ways to read it, tried in order, both through the Kubernetes
 * API server's proxy so no new network path or credential is needed:
 *
 *  1. **The cluster's Prometheus**, when one is scraping the exporter. This is
 *     the only source with *history*: a p95 over seven days is what makes a
 *     right-sizing suggestion defensible, so only this source produces one.
 *     Found by looking for the Services the common installs create
 *     (`prometheus-operated` from the operator, `*-prometheus-server` from the
 *     community chart, the kube-prometheus-stack Service), or named
 *     explicitly on the account.
 *  2. **The exporter pods themselves**, scraped once each. An instant sample:
 *     good enough to say whether GPUs that are requested are busy right now,
 *     never good enough to recommend a smaller one.
 *
 * Metric names are the exporters' own: `DCGM_FI_DEV_GPU_UTIL` (percent),
 * `DCGM_FI_PROF_GR_ENGINE_ACTIVE` (a 0..1 ratio, and the one that works on a
 * MIG instance), `DCGM_FI_DEV_FB_USED` /
 * `DCGM_FI_DEV_FB_FREE` (MiB); AMD's `gpu_gfx_activity` (percent) and
 * `gpu_used_vram` (MB). The exporter labels each series with the pod it is
 * assigned to as `pod` / `namespace` (older releases: `pod_name` /
 * `pod_namespace`). When Prometheus scrapes it without `honorLabels`, those
 * collide with the target's own labels and arrive as `exported_pod` /
 * `exported_namespace`, which therefore win when present.
 *
 * Why GR_ENGINE_ACTIVE for MIG: GPU_UTIL comes from NVML's device utilization
 * query, and NVML's header says "On MIG-enabled GPUs, querying device
 * utilization rates is not currently supported" (nvmlDeviceGetUtilizationRates,
 * https://github.com/NVIDIA/go-nvml/blob/main/gen/nvml/nvml.h). DCGM's own
 * guide shows GRACT (`PROF_GR_ENGINE_ACTIVE`, field 1001) reported per GPU
 * instance ("Metrics on Multi-Instance GPU",
 * https://docs.nvidia.com/datacenter/dcgm/latest/user-guide/feature-overview.html).
 *
 * Time-slicing is the case with no answer: DCGM cannot associate a shared
 * device's activity with any one of the containers sharing it, so those pods
 * read *unknown*, never a figure split by count.
 *
 * Never throws. A cluster with no exporter keeps every number it had and
 * says, in one line, why GPU utilization is missing.
 */

import type { K8sFetch } from "./shared.js";
import type { K8sPod, K8sService } from "./types.js";

/** What one pod's GPUs are doing. Fractions are 0..1. */
export interface PodGpuUsage {
  /** Mean busy fraction across the devices (or MIG instances) it holds. */
  utilization: number | null;
  /** Framebuffer in use now, MiB, summed across its devices. */
  memoryUsedMiB: number | null;
  /** p95 busy fraction over the history window. Prometheus only. */
  p95Utilization: number | null;
  /** Highest framebuffer use on any one of its devices in the window, MiB. */
  peakMemoryMiB: number | null;
  /** Devices or MIG instances reported for it. */
  devices: number;
}

export type GpuMetricsSource =
  | { kind: "prometheus"; target: string; history: boolean }
  | { kind: "exporter"; target: string; scraped: number }
  | { kind: "none"; reason: "disabled" | "not-found" | "unreachable" };

export interface GpuUtilization {
  source: GpuMetricsSource;
  /** `namespace/name` → usage. Empty when no source answered. */
  pods: Map<string, PodGpuUsage>;
}

/** The history window behind a right-sizing suggestion. */
export const GPU_HISTORY_WINDOW = "7d";

export const NO_GPU_UTILIZATION: GpuUtilization = {
  source: { kind: "none", reason: "not-found" },
  pods: new Map(),
};

type Labels = Record<string, string>;
interface Sample {
  labels: Labels;
  value: number;
}

/** The workload pod a series describes, or null for an unassigned device. */
function podKeyOf(labels: Labels): string | null {
  const pod = labels["exported_pod"] || labels["pod"] || labels["pod_name"] || "";
  const ns = labels["exported_namespace"] || labels["namespace"] || labels["pod_namespace"] || "";
  return pod && ns ? `${ns}/${pod}` : null;
}

/** One physical device or MIG instance, across exporters. */
function deviceKeyOf(labels: Labels): string {
  const device =
    labels["UUID"] || labels["uuid"] || labels["gpu_uuid"] || labels["gpu_id"] || labels["gpu"];
  const host = labels["hostname"] || labels["Hostname"] || labels["instance"] || "";
  return `${host}|${device ?? ""}|${labels["GPU_I_ID"] ?? labels["gpu_partition_id"] ?? ""}`;
}

function isMigInstance(labels: Labels): boolean {
  return Boolean(labels["GPU_I_PROFILE"] || labels["GPU_I_ID"]);
}

interface DeviceReading {
  pod: string;
  busy: number | null;
  memoryUsed: number | null;
  p95: number | null;
  peakMemory: number | null;
}

/**
 * Fold per-device readings into per-pod usage. Busy fraction prefers
 * GR_ENGINE_ACTIVE on a MIG instance (GPU_UTIL is not reported there) and
 * GPU_UTIL elsewhere, because that is the figure people know from nvidia-smi.
 */
function foldDevices(readings: Map<string, DeviceReading>): Map<string, PodGpuUsage> {
  const byPod = new Map<string, DeviceReading[]>();
  for (const reading of readings.values()) {
    const list = byPod.get(reading.pod);
    if (list) list.push(reading);
    else byPod.set(reading.pod, [reading]);
  }
  const out = new Map<string, PodGpuUsage>();
  for (const [pod, list] of byPod) {
    const busy = list.map((r) => r.busy).filter((v): v is number => v != null);
    const mem = list.map((r) => r.memoryUsed).filter((v): v is number => v != null);
    const p95 = list.map((r) => r.p95).filter((v): v is number => v != null);
    const peak = list.map((r) => r.peakMemory).filter((v): v is number => v != null);
    out.set(pod, {
      utilization: busy.length ? busy.reduce((a, b) => a + b, 0) / busy.length : null,
      memoryUsedMiB: mem.length ? mem.reduce((a, b) => a + b, 0) : null,
      // The busiest device's p95, not the mean: a right-sizing suggestion has
      // to fit the worst-loaded device the workload holds.
      p95Utilization: p95.length ? Math.max(...p95) : null,
      peakMemoryMiB: peak.length ? Math.max(...peak) : null,
      devices: list.length,
    });
  }
  return out;
}

/** Merge one metric's samples into the per-device map. */
function absorb(
  readings: Map<string, DeviceReading>,
  samples: Sample[],
  field: keyof Omit<DeviceReading, "pod">,
  transform: (value: number, labels: Labels) => number | null,
  only?: (labels: Labels) => boolean,
): void {
  for (const sample of samples) {
    if (only && !only(sample.labels)) continue;
    const pod = podKeyOf(sample.labels);
    if (!pod || !Number.isFinite(sample.value)) continue;
    const key = deviceKeyOf(sample.labels);
    const value = transform(sample.value, sample.labels);
    if (value == null) continue;
    const existing = readings.get(key);
    if (existing) {
      if (existing[field] == null) existing[field] = value;
    } else {
      readings.set(key, {
        pod,
        busy: null,
        memoryUsed: null,
        p95: null,
        peakMemory: null,
        [field]: value,
      });
    }
  }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// ─── Prometheus ──────────────────────────────────────────────────────────

/** `namespace/service:port` plus an optional path prefix (Thanos, a sub-path). */
interface PrometheusTarget {
  namespace: string;
  service: string;
  port: string;
  prefix: string;
}

export function describeTarget(t: PrometheusTarget): string {
  return `${t.namespace}/${t.service}:${t.port}${t.prefix}`;
}

/**
 * Parse the account's "GPU metrics source" field. `none` (or `off`) disables
 * GPU metrics entirely; anything else must be `namespace/service:port`, with
 * an optional `/path` after it.
 */
export function parseGpuMetricsSetting(
  raw: string | undefined,
): PrometheusTarget | "disabled" | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  if (/^(none|off|disabled)$/i.test(text)) return "disabled";
  const match = /^([a-z0-9-]+)\/([a-z0-9-]+)(?::([a-z0-9-]+))?(\/.*)?$/i.exec(text);
  if (!match) return null;
  return {
    namespace: match[1]!,
    service: match[2]!,
    port: match[3] ?? "9090",
    prefix: (match[4] ?? "").replace(/\/+$/, ""),
  };
}

const PROMETHEUS_EXCLUDE =
  /alertmanager|node-exporter|pushgateway|operator|adapter|blackbox|kube-state|grafana|thanos-sidecar/;

/**
 * Prometheus Services worth trying, best first. Only names and labels the
 * common installs actually produce; anything cleverer would be guessing.
 */
export function discoverPrometheus(services: K8sService[]): PrometheusTarget[] {
  const scored: Array<{ score: number; target: PrometheusTarget }> = [];
  for (const svc of services) {
    const name = svc.metadata.name;
    const labels = svc.metadata.labels ?? {};
    if (PROMETHEUS_EXCLUDE.test(name)) continue;
    let score = 0;
    if (name === "prometheus-operated") score = 4;
    else if (/prometheus-server$/.test(name)) score = 3;
    else if (labels["app.kubernetes.io/name"] === "prometheus") score = 2;
    else if (labels["app"] === "prometheus" || /(^|-)prometheus$/.test(name)) score = 1;
    if (score === 0) continue;
    const ports = svc.spec.ports ?? [];
    const port =
      ports.find((p) => p.name === "web" || p.name === "http-web") ??
      ports.find((p) => p.port === 9090) ??
      ports.find((p) => p.name === "http") ??
      ports[0];
    if (!port) continue;
    scored.push({
      score,
      target: {
        namespace: svc.metadata.namespace ?? "default",
        service: name,
        port: String(port.name || port.port),
        prefix: "",
      },
    });
  }
  return scored
    .sort(
      (a, b) =>
        b.score - a.score || describeTarget(a.target).localeCompare(describeTarget(b.target)),
    )
    .map((s) => s.target);
}

interface PromVectorResponse {
  status?: string;
  data?: { resultType?: string; result?: Array<{ metric?: Labels; value?: [number, string] }> };
}

async function promQuery(
  k8sFetch: K8sFetch,
  target: PrometheusTarget,
  query: string,
): Promise<Sample[]> {
  const path =
    `/api/v1/namespaces/${encodeURIComponent(target.namespace)}/services/` +
    `${encodeURIComponent(target.service)}:${encodeURIComponent(target.port)}/proxy` +
    `${target.prefix}/api/v1/query?query=${encodeURIComponent(query)}`;
  const body = await k8sFetch<PromVectorResponse>(path);
  if (body?.status !== "success") throw new Error("Prometheus query failed");
  return (body.data?.result ?? []).map((r) => ({
    labels: r.metric ?? {},
    value: Number(r.value?.[1]),
  }));
}

/**
 * Read one Prometheus. Returns null when it answered but holds no GPU series,
 * so the caller can try the next candidate; throws when it did not answer.
 */
async function readPrometheus(
  k8sFetch: K8sFetch,
  target: PrometheusTarget,
): Promise<{ pods: Map<string, PodGpuUsage>; history: boolean } | null> {
  const w = GPU_HISTORY_WINDOW;
  const optional = (query: string) => promQuery(k8sFetch, target, query).catch(() => []);
  // The first query is not optional: it is what tells "unreachable" apart.
  const util = await promQuery(k8sFetch, target, "avg_over_time(DCGM_FI_DEV_GPU_UTIL[1h])");
  const [engine, fbUsed, utilP95, enginePeak, fbPeak, amdUtil, amdP95, amdVram, amdVramPeak] =
    await Promise.all([
      optional("avg_over_time(DCGM_FI_PROF_GR_ENGINE_ACTIVE[1h])"),
      optional("avg_over_time(DCGM_FI_DEV_FB_USED[1h])"),
      optional(`quantile_over_time(0.95, DCGM_FI_DEV_GPU_UTIL[${w}])`),
      optional(`quantile_over_time(0.95, DCGM_FI_PROF_GR_ENGINE_ACTIVE[${w}])`),
      optional(`max_over_time(DCGM_FI_DEV_FB_USED[${w}])`),
      optional("avg_over_time(gpu_gfx_activity[1h])"),
      optional(`quantile_over_time(0.95, gpu_gfx_activity[${w}])`),
      optional("avg_over_time(gpu_used_vram[1h])"),
      optional(`max_over_time(gpu_used_vram[${w}])`),
    ]);
  if (util.length === 0 && engine.length === 0 && amdUtil.length === 0) return null;

  const readings = new Map<string, DeviceReading>();
  const mig = (l: Labels) => isMigInstance(l);
  const whole = (l: Labels) => !isMigInstance(l);
  absorb(readings, engine, "busy", clamp01, mig);
  absorb(readings, util, "busy", (v) => clamp01(v / 100), whole);
  absorb(readings, engine, "busy", clamp01);
  absorb(readings, amdUtil, "busy", (v) => clamp01(v / 100));
  absorb(readings, fbUsed, "memoryUsed", (v) => v);
  absorb(readings, amdVram, "memoryUsed", (v) => v);
  absorb(readings, enginePeak, "p95", clamp01, mig);
  absorb(readings, utilP95, "p95", (v) => clamp01(v / 100), whole);
  absorb(readings, amdP95, "p95", (v) => clamp01(v / 100));
  absorb(readings, fbPeak, "peakMemory", (v) => v);
  absorb(readings, amdVramPeak, "peakMemory", (v) => v);

  const history = utilP95.length > 0 || enginePeak.length > 0 || amdP95.length > 0;
  return { pods: foldDevices(readings), history };
}

// ─── Exporter scrape ─────────────────────────────────────────────────────

/** Parse Prometheus text exposition for the named metrics only. */
export function parseExposition(text: string, wanted: Set<string>): Map<string, Sample[]> {
  const out = new Map<string, Sample[]>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const brace = line.indexOf("{");
    const space = line.indexOf(" ");
    const nameEnd = brace >= 0 && (space < 0 || brace < space) ? brace : space;
    if (nameEnd <= 0) continue;
    const name = line.slice(0, nameEnd);
    if (!wanted.has(name)) continue;
    const labels: Labels = {};
    let rest = line.slice(nameEnd);
    if (rest.startsWith("{")) {
      let i = 1;
      while (i < rest.length && rest[i] !== "}") {
        const eq = rest.indexOf("=", i);
        if (eq < 0) break;
        const key = rest.slice(i, eq).trim().replace(/^,/, "").trim();
        let j = eq + 1;
        if (rest[j] !== '"') break;
        j += 1;
        let value = "";
        while (j < rest.length && rest[j] !== '"') {
          if (rest[j] === "\\" && j + 1 < rest.length) {
            const next = rest[j + 1]!;
            value += next === "n" ? "\n" : next;
            j += 2;
          } else {
            value += rest[j];
            j += 1;
          }
        }
        labels[key] = value;
        i = j + 1;
        while (rest[i] === "," || rest[i] === " ") i += 1;
      }
      rest = rest.slice(i + 1);
    }
    const value = Number(rest.trim().split(/\s+/)[0]);
    if (!Number.isFinite(value)) continue;
    const list = out.get(name);
    if (list) list.push({ labels, value });
    else out.set(name, [{ labels, value }]);
  }
  return out;
}

const EXPORTER_METRICS = new Set([
  "DCGM_FI_DEV_GPU_UTIL",
  "DCGM_FI_PROF_GR_ENGINE_ACTIVE",
  "DCGM_FI_DEV_FB_USED",
]);

function isDcgmExporterPod(pod: K8sPod): boolean {
  const labels = pod.metadata.labels ?? {};
  return (
    pod.status?.phase === "Running" &&
    (labels["app"] === "nvidia-dcgm-exporter" ||
      labels["app.kubernetes.io/name"] === "dcgm-exporter" ||
      labels["app"] === "dcgm-exporter")
  );
}

function exporterPort(pod: K8sPod): number {
  for (const container of pod.spec.containers ?? []) {
    for (const port of container.ports ?? []) {
      if (port.name === "gpu-metrics" || port.name === "metrics" || port.containerPort === 9400) {
        return port.containerPort;
      }
    }
  }
  return 9400;
}

async function scrapeExporters(
  fetchText: (path: string) => Promise<string>,
  pods: K8sPod[],
): Promise<{ pods: Map<string, PodGpuUsage>; scraped: number; namespace: string } | null> {
  const exporters = pods.filter(isDcgmExporterPod);
  if (exporters.length === 0) return null;

  const readings = new Map<string, DeviceReading>();
  let scraped = 0;
  // A handful at a time: one request per GPU node through the API server.
  const queue = [...exporters];
  const worker = async () => {
    for (;;) {
      const pod = queue.shift();
      if (!pod) return;
      const ns = pod.metadata.namespace ?? "default";
      const path =
        `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/` +
        `${encodeURIComponent(pod.metadata.name)}:${exporterPort(pod)}/proxy/metrics`;
      try {
        const text = await fetchText(path);
        const parsed = parseExposition(text, EXPORTER_METRICS);
        const util = parsed.get("DCGM_FI_DEV_GPU_UTIL") ?? [];
        const engine = parsed.get("DCGM_FI_PROF_GR_ENGINE_ACTIVE") ?? [];
        absorb(readings, engine, "busy", clamp01, isMigInstance);
        absorb(
          readings,
          util,
          "busy",
          (v) => clamp01(v / 100),
          (l) => !isMigInstance(l),
        );
        absorb(readings, engine, "busy", clamp01);
        absorb(readings, parsed.get("DCGM_FI_DEV_FB_USED") ?? [], "memoryUsed", (v) => v);
        scraped += 1;
      } catch {
        /* one unreachable node must not cost us the others */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, exporters.length) }, worker));
  if (scraped === 0) return null;
  return {
    pods: foldDevices(readings),
    scraped,
    namespace: exporters[0]!.metadata.namespace ?? "default",
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────

export interface GpuMetricsInputs {
  setting: string | undefined;
  services: K8sService[] | null;
  pods: K8sPod[];
  fetchText?: ((path: string) => Promise<string>) | undefined;
}

/**
 * Read GPU utilization from the best available source. Callers skip this
 * entirely on a cluster with no GPU requests: it costs list calls and proxied
 * queries that cannot change any number there.
 */
export async function fetchGpuUtilization(
  k8sFetch: K8sFetch,
  inputs: GpuMetricsInputs,
): Promise<GpuUtilization> {
  const setting = parseGpuMetricsSetting(inputs.setting);
  if (setting === "disabled") {
    return { source: { kind: "none", reason: "disabled" }, pods: new Map() };
  }

  const candidates = setting ? [setting] : discoverPrometheus(inputs.services ?? []).slice(0, 3);
  let anyUnreachable = false;
  for (const target of candidates) {
    try {
      const result = await readPrometheus(k8sFetch, target);
      if (result) {
        return {
          source: { kind: "prometheus", target: describeTarget(target), history: result.history },
          pods: result.pods,
        };
      }
    } catch {
      anyUnreachable = true;
    }
  }

  if (inputs.fetchText) {
    const scraped = await scrapeExporters(inputs.fetchText, inputs.pods).catch(() => null);
    if (scraped) {
      return {
        source: {
          kind: "exporter",
          target: `${scraped.namespace}/nvidia-dcgm-exporter`,
          scraped: scraped.scraped,
        },
        pods: scraped.pods,
      };
    }
  }

  return {
    source: { kind: "none", reason: setting || anyUnreachable ? "unreachable" : "not-found" },
    pods: new Map(),
  };
}

/** One line on where GPU utilization came from, or why there is none. */
export function describeGpuMetricsSource(source: GpuMetricsSource): string {
  switch (source.kind) {
    case "prometheus":
      return source.history
        ? `GPU utilization from Prometheus (${source.target}): last hour for idle, ${GPU_HISTORY_WINDOW} p95 for right-sizing.`
        : `GPU utilization from Prometheus (${source.target}), last hour. No ${GPU_HISTORY_WINDOW} history yet, so no right-sizing suggestions.`;
    case "exporter":
      return `GPU utilization sampled directly from ${source.scraped} DCGM exporter pod${source.scraped === 1 ? "" : "s"} (${source.target}). An instant sample: enough to show idle GPUs, not enough to suggest a smaller one. Point the account's GPU metrics source at a Prometheus that scrapes the exporter for ${GPU_HISTORY_WINDOW} history.`;
    default:
      switch (source.reason) {
        case "disabled":
          return "GPU metrics are turned off on this account, so GPU cost is allocated by requests alone.";
        case "unreachable":
          return "A GPU metrics source was found but did not answer through the Kubernetes API proxy. GPU cost is allocated by requests alone.";
        default:
          return "No GPU metrics found (no NVIDIA DCGM or AMD exporter, or Prometheus scraping one). GPU cost is allocated by requests alone.";
      }
  }
}
