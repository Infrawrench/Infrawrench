/**
 * The poller's synthetic-probe pass: claim due probes, run each through the
 * egress proxy's `/probe` endpoint, record the result as metric points, and
 * run the up/down state machine.
 *
 * `synthetic_probes.next_probe_at` is the due-time column AND the claim lease
 * (the `metric_alert_rules.next_eval_at` protocol) with one twist: the claim
 * writes `now() + interval_seconds` — the lease IS the next cadence, so the
 * normal completion path never has to reschedule, and a replica that dies
 * mid-probe simply lets the probe come due again at its own interval.
 *
 * Probing happens from OUTSIDE the cluster on purpose: the request leaves
 * from the egress-proxy Worker on Cloudflare's edge, so latency and
 * reachability are measured from an external vantage point (and the pod never
 * makes arbitrary outbound requests itself — the same reasoning as
 * `workflows/fetch.ts`).
 *
 * Configuration is the workflow proxy's own env pair
 * (`WORKFLOW_FETCH_PROXY_URL` / `WORKFLOW_FETCH_PROXY_TOKEN`) — but where a
 * workflow's fetch throws when they're missing, probes SKIP: monitoring is a
 * best-effort surface (the ClickHouse stance), and a deployment without the
 * proxy simply has probes that never run rather than a poller that logs an
 * error every tick.
 *
 * Never throws — this runs inside the poller loop and must not fail a tick.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { syntheticProbes } from "../db/schema";
import { flattenMetricSeries, insertMetricPoints } from "../clickhouse/writers";
import { sendPushToOrg } from "../push/dispatch";
import { sendSlackToOrg } from "../slack";
import { sendMsTeamsToOrg } from "../msteams";
import type { ProbeRecord } from "./store";

/**
 * The synthetic identity probe results are written to ClickHouse under. Not a
 * real plugin: the constant ids exist so probe series live beside plugin
 * metric series in the same tables and the existing readers/charts work
 * unchanged, while staying unmistakably distinct from any synced resource.
 */
export const PROBE_PLUGIN_ID = "synthetic-probe";
export const PROBE_RESOURCE_TYPE_ID = "probe";

/** The ClickHouse `resource_id` for one probe's series. */
export function probeMetricResourceId(probeId: string): string {
  return `probe:${probeId}`;
}

/** How long we wait on the proxy itself, beyond the probe's own timeout. */
const PROXY_OVERHEAD_MS = 10_000;

function proxyUrl(): string | null {
  const raw = process.env["WORKFLOW_FETCH_PROXY_URL"];
  return raw ? raw.replace(/\/$/, "") : null;
}

function proxyToken(): string | null {
  return process.env["WORKFLOW_FETCH_PROXY_TOKEN"] ?? null;
}

/** Whether this deployment can run synthetic probes at all. */
export function isProbeProxyConfigured(): boolean {
  return Boolean(proxyUrl() && proxyToken());
}

/** What the proxy's `/probe` endpoint returns inside its envelope. */
export interface ProbeProxyResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
}

/**
 * Claim up to `limit` due enabled probes. The lease written is the probe's
 * own interval (floored at 60s to protect the shared proxy even if a stored
 * row predates the check constraint).
 */
export async function claimDueProbes(limit: number): Promise<ProbeRecord[]> {
  const rows = await db.execute(sql`
    UPDATE synthetic_probes
    SET next_probe_at = now() + GREATEST(interval_seconds, 60) * interval '1 second'
    WHERE id IN (
      SELECT id FROM synthetic_probes
      WHERE enabled = true
        AND (next_probe_at IS NULL OR next_probe_at <= now())
      ORDER BY last_probe_at ASC NULLS FIRST, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);

  return Array.from(rows as Iterable<Record<string, unknown>>, (r) => ({
    id: String(r["id"]),
    organizationId: String(r["organization_id"]),
    name: String(r["name"]),
    url: String(r["url"]),
    method: String(r["method"]),
    intervalSeconds: Number(r["interval_seconds"]),
    timeoutMs: Number(r["timeout_ms"]),
    failureThreshold: Number(r["failure_threshold"]),
    enabled: Boolean(r["enabled"]),
    accountId: r["account_id"] === null ? null : String(r["account_id"]),
    resourceId: r["resource_id"] === null ? null : String(r["resource_id"]),
    pluginId: r["plugin_id"] === null ? null : String(r["plugin_id"]),
    resourceTypeId: r["resource_type_id"] === null ? null : String(r["resource_type_id"]),
    outputKey: r["output_key"] === null ? null : String(r["output_key"]),
    consecutiveFailures: Number(r["consecutive_failures"]),
    status: String(r["status"]) as ProbeRecord["status"],
    lastProbeAt: r["last_probe_at"] === null ? null : new Date(String(r["last_probe_at"])),
    nextProbeAt: r["next_probe_at"] === null ? null : new Date(String(r["next_probe_at"])),
    lastStatusCode: r["last_status_code"] === null ? null : Number(r["last_status_code"]),
    lastLatencyMs: r["last_latency_ms"] === null ? null : Number(r["last_latency_ms"]),
    lastError: r["last_error"] === null ? null : String(r["last_error"]),
    lastStateChangeAt:
      r["last_state_change_at"] === null ? null : new Date(String(r["last_state_change_at"])),
    createdByUserId: r["created_by_user_id"] === null ? null : String(r["created_by_user_id"]),
    createdAt: new Date(String(r["created_at"])),
    updatedAt: new Date(String(r["updated_at"])),
  }));
}

/**
 * Run one probe through the proxy. Returns null when the *proxy itself*
 * failed (unreachable, bad token, 5xx) — that is an infrastructure problem,
 * not evidence about the endpoint, so the caller records nothing rather than
 * marking a healthy endpoint down.
 */
async function probeThroughProxy(probe: ProbeRecord): Promise<ProbeProxyResult | null> {
  const base = proxyUrl();
  const token = proxyToken();
  if (!base || !token) return null;
  try {
    const res = await fetch(`${base}/probe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        url: probe.url,
        method: probe.method,
        timeoutMs: probe.timeoutMs,
      }),
      signal: AbortSignal.timeout(probe.timeoutMs + PROXY_OVERHEAD_MS),
    });
    const envelope = (await res.json()) as { result?: ProbeProxyResult; error?: unknown };
    if (!res.ok || !envelope.result) {
      console.error(
        `[probes] probe ${probe.id} proxy error (HTTP ${res.status}):`,
        envelope.error ?? "no result",
      );
      return null;
    }
    return envelope.result;
  } catch (err) {
    console.error(`[probes] probe ${probe.id} could not reach the egress proxy:`, err);
    return null;
  }
}

/** Deep link to the probes page, for the Slack/Teams message button. */
function probesUrl(organizationId: string): string | null {
  const base = process.env["APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/org/${organizationId}/probes`;
}

function describeFailure(result: ProbeProxyResult): string {
  if (result.status !== undefined) return `HTTP ${result.status}`;
  return result.error ?? "request failed";
}

async function notifyDown(probe: ProbeRecord, result: ProbeProxyResult): Promise<void> {
  const detail = describeFailure(result);
  const title = `Probe down: ${probe.name}`;
  const body =
    `infrawrench probe "${probe.name}" is down: ${probe.url} failed ` +
    `${probe.failureThreshold} consecutive check${probe.failureThreshold === 1 ? "" : "s"} (${detail})`;
  const context = `${probe.method} ${probe.url} · down`;

  await sendPushToOrg(probe.organizationId, "probeAlerts", {
    title,
    body,
    data: {
      type: "probe_alert",
      orgId: probe.organizationId,
      probeId: probe.id,
      status: "down",
    },
  });
  const url = probesUrl(probe.organizationId);
  await sendSlackToOrg(probe.organizationId, "probeAlerts", {
    title,
    body,
    context,
    ...(url ? { url } : {}),
  });
  await sendMsTeamsToOrg(probe.organizationId, "probeAlerts", {
    title,
    body,
    context,
    ...(url ? { url } : {}),
  });
}

async function notifyRecovered(probe: ProbeRecord, result: ProbeProxyResult): Promise<void> {
  const title = `Probe recovered: ${probe.name}`;
  const body =
    `infrawrench probe "${probe.name}" recovered: ${probe.url} is answering again` +
    (result.status !== undefined ? ` (HTTP ${result.status}, ${result.latencyMs}ms)` : "");
  const context = `${probe.method} ${probe.url} · recovered`;

  await sendPushToOrg(probe.organizationId, "probeAlerts", {
    title,
    body,
    data: {
      type: "probe_alert",
      orgId: probe.organizationId,
      probeId: probe.id,
      status: "up",
    },
  });
  const url = probesUrl(probe.organizationId);
  await sendSlackToOrg(probe.organizationId, "probeAlerts", {
    title,
    body,
    context,
    ...(url ? { url } : {}),
  });
  await sendMsTeamsToOrg(probe.organizationId, "probeAlerts", {
    title,
    body,
    context,
    ...(url ? { url } : {}),
  });
}

/**
 * Record one result: two metric points (Latency in ms, Up as 0/1) beside the
 * plugin metric series, the `last_*` columns, and the state machine —
 * `consecutiveFailures` climbs to `failureThreshold` before "down" fires, and
 * any success snaps back to "up" (with a recovery notification only when the
 * probe was previously down).
 */
export async function recordProbeResult(
  probe: ProbeRecord,
  result: ProbeProxyResult,
  now = new Date(),
): Promise<void> {
  // Best-effort, like every metric write: a ClickHouse outage costs history,
  // never state transitions.
  await insertMetricPoints(
    flattenMetricSeries(
      {
        organizationId: probe.organizationId,
        accountId: probe.accountId ?? "",
        resourceId: probeMetricResourceId(probe.id),
        pluginId: PROBE_PLUGIN_ID,
        resourceTypeId: PROBE_RESOURCE_TYPE_ID,
      },
      [
        {
          label: "Latency",
          unit: "ms",
          points: [{ timestamp: now.getTime(), value: result.latencyMs }],
        },
        { label: "Up", unit: "", points: [{ timestamp: now.getTime(), value: result.ok ? 1 : 0 }] },
      ],
    ),
  );

  const consecutiveFailures = result.ok ? 0 : probe.consecutiveFailures + 1;
  const wentDown =
    !result.ok && probe.status !== "down" && consecutiveFailures >= probe.failureThreshold;
  const recovered = result.ok && probe.status === "down";
  const status: ProbeRecord["status"] = result.ok ? "up" : wentDown ? "down" : probe.status;
  const stateChanged = status !== probe.status;

  await db
    .update(syntheticProbes)
    .set({
      consecutiveFailures,
      status,
      lastProbeAt: now,
      lastStatusCode: result.status ?? null,
      lastLatencyMs: Math.round(result.latencyMs),
      lastError: result.ok ? null : describeFailure(result),
      ...(stateChanged ? { lastStateChangeAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(syntheticProbes.id, probe.id));

  // Notify after the state is durable, so a crashed notification never leaves
  // the row claiming an alert that was sent. The claim lease means only one
  // replica ever holds this probe, so there is no cross-replica dedupe to do.
  if (wentDown) await notifyDown(probe, result);
  else if (recovered) await notifyRecovered(probe, result);
}

async function runOne(probe: ProbeRecord): Promise<void> {
  try {
    const result = await probeThroughProxy(probe);
    if (result === null) return; // proxy trouble: record nothing, retry next interval
    await recordProbeResult(probe, result);
  } catch (err) {
    console.error(`[probes] probe ${probe.id} failed:`, err);
  }
}

/** What one pass did, for tests and logs. */
export interface ProbePassOutcome {
  claimed: number;
}

let warnedUnconfigured = false;

/** Claim and run a bounded batch of due probes. Never throws. */
export async function runProbePass(options: { limit?: number } = {}): Promise<ProbePassOutcome> {
  // No proxy, no probes — but say so once, or a misconfigured deployment
  // reads as "everything is up" with zero samples to show for it.
  if (!isProbeProxyConfigured()) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(
        "[probes] WORKFLOW_FETCH_PROXY_URL/_TOKEN not set — synthetic probes are disabled; no measurements or alerts will be produced",
      );
    }
    return { claimed: 0 };
  }

  const limit = options.limit ?? 8;
  let claimed: ProbeRecord[];
  try {
    claimed = await claimDueProbes(limit);
  } catch (err) {
    console.error("[probes] claim failed:", err);
    return { claimed: 0 };
  }
  if (claimed.length === 0) return { claimed: 0 };

  await Promise.allSettled(claimed.map((probe) => runOne(probe)));
  return { claimed: claimed.length };
}
