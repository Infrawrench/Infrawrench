/**
 * Heartbeat alerts: a heartbeat going down (missed or failed) and coming back.
 * Both ride the `heartbeatAlerts` trigger through `routeAlert`, so they reach
 * every channel the org's routing rules send it to, with the probe alerts'
 * lifecycle key shape: the open and the resolve pair up, and an unacknowledged
 * outage escalates through the normal follow-up pass.
 */
import { routeAlert } from "../alerts/route";
import { orgAppUrl } from "../app-url";
import { notifyResourceOwner, ownerContextLine } from "../ownership/notify";
import { lookupResourceOwner } from "../ownership/store";
import type { HeartbeatRecord } from "./store";

function minutes(n: number): string {
  return `${n} minute${n === 1 ? "" : "s"}`;
}

/** The owner of the resource this heartbeat watches; never costs the alert. */
async function lookupOwnerQuietly(heartbeat: HeartbeatRecord) {
  if (!heartbeat.resourceId) return null;
  try {
    return await lookupResourceOwner(heartbeat.organizationId, heartbeat.resourceId);
  } catch (err) {
    console.error("[heartbeats] owner lookup failed:", err);
    return null;
  }
}

export async function notifyHeartbeatDown(
  heartbeat: HeartbeatRecord,
  reason: "missed" | "failed",
  detail?: string | null,
): Promise<void> {
  const title =
    reason === "failed" ? `Job failed: ${heartbeat.name}` : `Heartbeat missed: ${heartbeat.name}`;
  const what =
    reason === "failed"
      ? `reported a failure${detail ? `: ${detail.slice(0, 300)}` : ""}`
      : heartbeat.lastPingAt
        ? `has not pinged since ${heartbeat.lastPingAt.toISOString()}, past its ${minutes(heartbeat.graceMinutes)} grace period`
        : `missed its ping, past its ${minutes(heartbeat.graceMinutes)} grace period`;
  const owner = await lookupOwnerQuietly(heartbeat);
  const ownerLine = ownerContextLine(owner);
  const body =
    `infrawrench heartbeat "${heartbeat.name}" ${what}` + (ownerLine ? `\n${ownerLine}` : "");

  await routeAlert({
    organizationId: heartbeat.organizationId,
    trigger: "heartbeatAlerts",
    title,
    body,
    context: reason === "failed" ? "heartbeat · failed" : "heartbeat · missed",
    url: orgAppUrl(heartbeat.organizationId, "heartbeats"),
    pushData: {
      type: "heartbeat_alert",
      orgId: heartbeat.organizationId,
      heartbeatId: heartbeat.id,
      status: "down",
    },
    facts: {
      key: heartbeat.name,
      ...(heartbeat.resourceId ? { resourceId: heartbeat.resourceId } : {}),
    },
    lifecycle: { key: `heartbeat:${heartbeat.id}`, phase: "open" },
  });
  await notifyResourceOwner(
    heartbeat.organizationId,
    heartbeat.resourceId,
    "heartbeatAlerts",
    (o) => ({
      title: `Your scheduled job ${reason === "failed" ? "failed" : "missed its heartbeat"}: ${heartbeat.name}`,
      body: `It ${what}. You are recorded as its owner${o.purpose ? `: ${o.purpose}` : ""}.`,
      data: {
        type: "heartbeat_alert",
        orgId: heartbeat.organizationId,
        heartbeatId: heartbeat.id,
        status: "down",
      },
    }),
  );
}

export async function notifyHeartbeatRecovered(heartbeat: HeartbeatRecord): Promise<void> {
  await routeAlert({
    organizationId: heartbeat.organizationId,
    trigger: "heartbeatAlerts",
    // Recovery is not a page: the probes and metric alerts stance.
    severity: "info",
    title: `Heartbeat recovered: ${heartbeat.name}`,
    body: `infrawrench heartbeat "${heartbeat.name}" is pinging again.`,
    context: "heartbeat · recovered",
    url: orgAppUrl(heartbeat.organizationId, "heartbeats"),
    pushData: {
      type: "heartbeat_alert",
      orgId: heartbeat.organizationId,
      heartbeatId: heartbeat.id,
      status: "up",
    },
    facts: { key: heartbeat.name },
    lifecycle: { key: `heartbeat:${heartbeat.id}`, phase: "resolved" },
  });
}
