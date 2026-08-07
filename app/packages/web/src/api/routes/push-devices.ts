import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../../db/client";
import { organizationMembers, pushDevices, pushPreferences, users } from "../../db/schema";
import { sendTestPushToUser } from "@infrawrench/server-core/push/dispatch";
import {
  DEFAULT_MUTED_TRIGGERS,
  isAlertTrigger,
  type AlertTrigger,
} from "@infrawrench/client-core";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

/**
 * Mobile push device + preference routes. Devices are user-scoped (a phone
 * belongs to a person, registered once across orgs) and are mounted on the
 * user-level `authed` router; preferences are per-(user, org) and mounted
 * org-scoped. Both work with the mobile app's WorkOS Bearer tokens because
 * sessionMiddleware accepts them.
 */

const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[.+\]$/;

/* ------------------------- user-level: /api/push ------------------------- */

const pushDeviceRoutes = new Hono();

interface RegisterDeviceBody {
  expoPushToken: string;
  platform: "ios" | "android";
  deviceName?: string;
}

pushDeviceRoutes.post("/devices", async (c) => {
  const session = c.get("session");
  const body = await c.req.json<RegisterDeviceBody>();

  const token = body.expoPushToken?.trim();
  if (!token || !EXPO_TOKEN_RE.test(token)) {
    return c.json({ error: "expoPushToken must be an ExponentPushToken[...] string" }, 400);
  }
  if (token.length > 500) return c.json({ error: "expoPushToken is too long" }, 400);
  if (body.platform !== "ios" && body.platform !== "android") {
    return c.json({ error: 'platform must be "ios" or "android"' }, 400);
  }
  const deviceName = body.deviceName?.trim().slice(0, 100) || null;

  const id = randomUUID();
  const now = new Date();
  // Upsert on the token: re-registration refreshes lastSeenAt, revives a
  // disabled device, and reassigns the row if the phone changed hands.
  const [row] = await db
    .insert(pushDevices)
    .values({
      id,
      userId: session.userId,
      expoPushToken: token,
      platform: body.platform,
      deviceName,
    })
    .onConflictDoUpdate({
      target: pushDevices.expoPushToken,
      set: {
        userId: session.userId,
        platform: body.platform,
        deviceName,
        lastSeenAt: now,
        failureCount: 0,
        disabledAt: null,
        updatedAt: now,
      },
    })
    .returning({ id: pushDevices.id });
  return c.json({ id: row?.id ?? id });
});

pushDeviceRoutes.get("/devices", async (c) => {
  const session = c.get("session");
  const rows = await db
    .select()
    .from(pushDevices)
    .where(eq(pushDevices.userId, session.userId))
    .orderBy(pushDevices.createdAt);
  return c.json(
    rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      deviceName: r.deviceName,
      lastSeenAt: r.lastSeenAt.toISOString(),
      disabled: r.disabledAt !== null,
    })),
  );
});

pushDeviceRoutes.delete("/devices/:id", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const result = await db
    .delete(pushDevices)
    .where(and(eq(pushDevices.id, id), eq(pushDevices.userId, session.userId)))
    .returning({ id: pushDevices.id });
  if (result.length === 0) return c.json({ error: "Device not found" }, 404);
  return c.json({ ok: true });
});

/* -------------------- org-scoped: /api/org/:orgId/push -------------------- */

const pushOrgRoutes = new Hono();

/**
 * A member's mutes for this org.
 *
 * One array in place of eleven booleans. The shape change is the whole point of
 * the routing refactor at this layer: a new trigger no longer needs a column, a
 * payload field, a default, an insert value, an upsert branch and an audit key
 * — six edits in this file alone — because "not muted" is the default for any
 * name the member has not written down.
 */
interface PreferencesPayload {
  mutedTriggers: AlertTrigger[];
}

pushOrgRoutes.get("/preferences", async (c) => {
  const session = c.get("session");
  const organizationId = c.get("organizationId");
  const [row] = await db
    .select()
    .from(pushPreferences)
    .where(
      and(
        eq(pushPreferences.userId, session.userId),
        eq(pushPreferences.organizationId, organizationId),
      ),
    );
  // No row means the shipped defaults, not "nothing muted" — `resourceDrift`
  // ships muted, and returning an empty list would tell the client the opposite.
  const payload: PreferencesPayload = {
    mutedTriggers: (row?.mutedTriggers as AlertTrigger[] | undefined) ?? [
      ...DEFAULT_MUTED_TRIGGERS,
    ],
  };
  return c.json(payload);
});

pushOrgRoutes.put("/preferences", async (c) => {
  const session = c.get("session");
  const organizationId = c.get("organizationId");
  const body = await c.req.json<Partial<PreferencesPayload>>();

  if (!Array.isArray(body.mutedTriggers)) {
    return c.json({ error: "mutedTriggers must be an array" }, 400);
  }
  // Unknown names are rejected rather than stored. A mute list is small and
  // hand-editable, and silently keeping a typo would look like it worked while
  // the trigger it was meant to silence kept arriving.
  const unknown = body.mutedTriggers.filter((t) => typeof t !== "string" || !isAlertTrigger(t));
  if (unknown.length > 0) {
    return c.json({ error: `Unknown trigger(s): ${unknown.join(", ")}` }, 400);
  }
  const muted = [...new Set(body.mutedTriggers)];

  const now = new Date();
  await db
    .insert(pushPreferences)
    .values({
      id: randomUUID(),
      userId: session.userId,
      organizationId,
      mutedTriggers: muted,
    })
    .onConflictDoUpdate({
      target: [pushPreferences.userId, pushPreferences.organizationId],
      set: { mutedTriggers: muted, updatedAt: now },
    });

  await logAudit({
    organizationId,
    userId: session.userId,
    action: "push.preferences.update",
    entityType: "push_preferences",
    entityId: session.userId,
    metadata: { mutedTriggers: muted },
  });
  return c.json({ ok: true });
});

/**
 * Admin roster: which members have at least one active device, and their
 * effective per-org preferences. Same gate as the Twilio settings page.
 */
pushOrgRoutes.get("/recipients", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      deviceId: pushDevices.id,
      platform: pushDevices.platform,
      deviceName: pushDevices.deviceName,
      disabledAt: pushDevices.disabledAt,
      mutedTriggers: pushPreferences.mutedTriggers,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(organizationMembers.userId, users.id))
    .innerJoin(pushDevices, eq(pushDevices.userId, organizationMembers.userId))
    .leftJoin(
      pushPreferences,
      and(
        eq(pushPreferences.userId, organizationMembers.userId),
        eq(pushPreferences.organizationId, organizationMembers.organizationId),
      ),
    )
    .where(
      and(eq(organizationMembers.organizationId, organizationId), isNull(pushDevices.disabledAt)),
    );

  // Group devices per member; an absent preference row means the shipped
  // defaults, which is not the same as "nothing muted".
  const byUser = new Map<
    string,
    {
      userId: string;
      email: string;
      displayName: string | null;
      mutedTriggers: AlertTrigger[];
      devices: Array<{ id: string; platform: string; deviceName: string | null }>;
    }
  >();
  for (const r of rows) {
    let entry = byUser.get(r.userId);
    if (!entry) {
      entry = {
        userId: r.userId,
        email: r.email,
        displayName: r.displayName,
        mutedTriggers: (r.mutedTriggers as AlertTrigger[] | null) ?? [...DEFAULT_MUTED_TRIGGERS],
        devices: [],
      };
      byUser.set(r.userId, entry);
    }
    entry.devices.push({ id: r.deviceId, platform: r.platform, deviceName: r.deviceName });
  }
  return c.json([...byUser.values()]);
});

pushOrgRoutes.post("/test", async (c) => {
  const session = c.get("session");
  const organizationId = c.get("organizationId");
  try {
    const summary = await sendTestPushToUser(session.userId, organizationId);
    return c.json({ ok: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send test push";
    return c.json({ error: message }, 400);
  }
});

export { pushDeviceRoutes, pushOrgRoutes };
