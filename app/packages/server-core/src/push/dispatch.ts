import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { organizationMembers, pushDevices, pushPreferences } from "../db/schema";
import { sendExpoPush, type ExpoPushMessage, type ExpoTicket } from "./expo-client";
import type { PushMessage, PushResult, PushTrigger } from "./types";

/**
 * Org-level mobile push fan-out. A second delivery transport alongside the
 * Twilio pager: incident/threshold detection stays in twilio-pager.ts and
 * budget-eval.ts; this module only resolves recipients and talks to Expo.
 *
 * Like the pager, dispatch must never break the poller: every entry point
 * catches and logs instead of throwing.
 *
 * The contract types live in `./types` so that the Expo transport can describe
 * its payload without importing this module (which opens a DB connection at
 * module scope). They are re-exported here for the existing
 * `@infrawrench/server-core/push/dispatch` import sites.
 */

export type { PushData, PushMessage, PushResult, PushTrigger } from "./types";

/** Disable a device after this many consecutive failed sends. */
const MAX_FAILURES = 5;

interface TargetDevice {
  id: string;
  expoPushToken: string;
}

/**
 * Resolve the active devices of all org members whose per-org preference
 * enables `trigger` (no preference row = enabled).
 */
async function resolveTargets(
  organizationId: string,
  trigger: PushTrigger,
): Promise<TargetDevice[]> {
  const prefColumn = {
    syncIncidents: pushPreferences.syncIncidents,
    budgetAlerts: pushPreferences.budgetAlerts,
    anomalyAlerts: pushPreferences.anomalyAlerts,
    metricAlerts: pushPreferences.metricAlerts,
    resourceDrift: pushPreferences.resourceDrift,
    workflowPages: pushPreferences.workflowPages,
    providerIncidents: pushPreferences.providerIncidents,
    expiryAlerts: pushPreferences.expiryAlerts,
    logMatchAlerts: pushPreferences.logMatchAlerts,
  }[trigger];
  return db
    .select({ id: pushDevices.id, expoPushToken: pushDevices.expoPushToken })
    .from(organizationMembers)
    .innerJoin(pushDevices, eq(pushDevices.userId, organizationMembers.userId))
    .leftJoin(
      pushPreferences,
      and(
        eq(pushPreferences.userId, organizationMembers.userId),
        eq(pushPreferences.organizationId, organizationMembers.organizationId),
      ),
    )
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        isNull(pushDevices.disabledAt),
        sql`(${pushPreferences.id} IS NULL OR ${prefColumn} = true)`,
      ),
    );
}

/**
 * Per-ticket bookkeeping: prune tokens Expo says are dead, count consecutive
 * failures toward disabling, reset the counter on success.
 */
async function noteTickets(devices: TargetDevice[], tickets: ExpoTicket[]): Promise<number> {
  const dead: string[] = [];
  const failed: string[] = [];
  const ok: string[] = [];
  devices.forEach((device, i) => {
    const ticket = tickets[i];
    if (!ticket || ticket.status === "error") {
      if (ticket?.details?.error === "DeviceNotRegistered") dead.push(device.id);
      else failed.push(device.id);
    } else {
      ok.push(device.id);
    }
  });

  if (dead.length > 0) {
    await db.delete(pushDevices).where(inArray(pushDevices.id, dead));
  }
  if (failed.length > 0) {
    await db
      .update(pushDevices)
      .set({
        failureCount: sql`${pushDevices.failureCount} + 1`,
        disabledAt: sql`CASE WHEN ${pushDevices.failureCount} + 1 >= ${MAX_FAILURES} THEN now() ELSE NULL END`,
        updatedAt: new Date(),
      })
      .where(inArray(pushDevices.id, failed));
  }
  if (ok.length > 0) {
    await db
      .update(pushDevices)
      .set({ failureCount: 0, updatedAt: new Date() })
      .where(inArray(pushDevices.id, ok));
  }
  return ok.length;
}

type IosInterruptionLevel = NonNullable<ExpoPushMessage["interruptionLevel"]>;

/**
 * Every push we send is an alert — a sync incident, a budget breach, a workflow
 * page, or the test that proves those will arrive. So all of them go out at the
 * top delivery tier on both platforms:
 *
 * - `priority: "high"` is APNs 10 / FCM high: delivered immediately instead of
 *   being throttled and batched for battery. iOS already defaults to high, but
 *   Android defaults to normal and an inherited default is not a guarantee.
 * - `interruptionLevel` is `time-sensitive` for everything, with pages the one
 *   trigger that can go higher (see `interruptionLevelFor`). Time-sensitive
 *   (iOS 15+) lights the screen and breaks through Focus and Do Not Disturb —
 *   the setting that decides whether a 3am page wakes anyone. It needs the
 *   time-sensitive entitlement, declared in mobile's `app.config.ts`; without
 *   it iOS quietly downgrades to `active`. The Android equivalent is the
 *   `incidents` channel, already created at `AndroidImportance.HIGH`.
 *
 * The user still has the last word — iOS exposes a per-app "Time Sensitive
 * Notifications" toggle — which is the right place for that decision to live.
 */
function toExpoMessage(
  device: TargetDevice,
  msg: PushMessage,
  interruptionLevel: IosInterruptionLevel,
): ExpoPushMessage {
  return {
    to: device.expoPushToken,
    title: msg.title,
    body: msg.body,
    data: msg.data,
    sound: "default",
    channelId: "incidents",
    priority: "high",
    interruptionLevel,
  };
}

/**
 * A workflow page is the one trigger that means "a human needs to act now", so
 * it is the one allowed above `time-sensitive`. `critical` is the only higher
 * iOS level: it bypasses Do Not Disturb *and* the ringer switch, and unlike
 * time-sensitive the user cannot pre-emptively turn it off per app.
 *
 * It is off unless `PUSH_CRITICAL_ALERTS` is set, because sending it before iOS
 * will honour it is a regression rather than a no-op, and the failure is silent
 * in both directions:
 *
 * - `critical` needs `com.apple.developer.usernotifications.critical-alerts`,
 *   which Apple grants case by case via a request form — not an entitlement we
 *   can grant ourselves the way time-sensitive is. Apple documents the entitled
 *   behaviour only; what an unentitled `critical` degrades to is unspecified,
 *   and "quietly treated as `active`" would make pages *quieter* than the
 *   time-sensitive they get today.
 * - The user must also grant `allowCriticalAlerts` separately, and iOS only
 *   offers it in the app's first authorization prompt (mobile `lib/push.ts`).
 *
 * So the flag stays off until the entitlement is approved, declared in mobile's
 * `app.config.ts`, and enabled on the App ID. See KNOWLEDGE.md for the rollout.
 */
function interruptionLevelFor(trigger: PushTrigger | "test"): IosInterruptionLevel {
  const enabled = process.env.PUSH_CRITICAL_ALERTS === "1";
  return trigger === "workflowPages" && enabled ? "critical" : "time-sensitive";
}

/**
 * Send `msg` to every eligible device in the org. Returns delivery counts the
 * caller can combine with Twilio's (e.g. to decide whether to set `pagedAt`).
 */
export async function sendPushToOrg(
  organizationId: string,
  trigger: PushTrigger,
  msg: PushMessage,
): Promise<PushResult> {
  try {
    const devices = await resolveTargets(organizationId, trigger);
    if (devices.length === 0) return { attempted: 0, succeeded: 0 };
    const level = interruptionLevelFor(trigger);
    const tickets = await sendExpoPush(devices.map((d) => toExpoMessage(d, msg, level)));
    const succeeded = await noteTickets(devices, tickets);
    return { attempted: devices.length, succeeded };
  } catch (err) {
    console.error("[push] sendPushToOrg failed:", err);
    return { attempted: 0, succeeded: 0 };
  }
}

/**
 * Send a test notification to the caller's own devices only. Used by the
 * "Send test push" button in settings. Unlike org fan-out this throws on
 * total failure so the API route can surface an actionable error.
 */
export async function sendTestPushToUser(userId: string, orgId: string): Promise<PushResult> {
  const devices = await db
    .select({ id: pushDevices.id, expoPushToken: pushDevices.expoPushToken })
    .from(pushDevices)
    .where(and(eq(pushDevices.userId, userId), isNull(pushDevices.disabledAt)));
  if (devices.length === 0) {
    throw new Error("No registered devices — sign in on the mobile app first");
  }
  const msg: PushMessage = {
    title: "Test notification",
    body: "Your Infrawrench push configuration is working.",
    data: { type: "test", orgId },
  };
  const tickets = await sendExpoPush(
    devices.map((d) => toExpoMessage(d, msg, interruptionLevelFor("test"))),
  );
  const succeeded = await noteTickets(devices, tickets);
  if (succeeded === 0) {
    throw new Error(`Test push failed: 0/${devices.length} deliveries succeeded`);
  }
  return { attempted: devices.length, succeeded };
}
