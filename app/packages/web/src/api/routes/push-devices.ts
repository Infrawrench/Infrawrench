import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../../db/client";
import { organizationMembers, pushDevices, pushPreferences, users } from "../../db/schema";
import { sendTestPushToUser } from "@infrawrench/server-core/push/dispatch";
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

interface PreferencesPayload {
  syncIncidents: boolean;
  budgetAlerts: boolean;
  workflowPages: boolean;
}

const PREFERENCE_KEYS = ["syncIncidents", "budgetAlerts", "workflowPages"] as const;

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
  const payload: PreferencesPayload = {
    syncIncidents: row?.syncIncidents ?? true,
    budgetAlerts: row?.budgetAlerts ?? true,
    workflowPages: row?.workflowPages ?? true,
  };
  return c.json(payload);
});

pushOrgRoutes.put("/preferences", async (c) => {
  const session = c.get("session");
  const organizationId = c.get("organizationId");
  const body = await c.req.json<Partial<PreferencesPayload>>();

  for (const key of PREFERENCE_KEYS) {
    if (body[key] != null && typeof body[key] !== "boolean") {
      return c.json({ error: `${key} must be a boolean` }, 400);
    }
  }

  const now = new Date();
  await db
    .insert(pushPreferences)
    .values({
      id: randomUUID(),
      userId: session.userId,
      organizationId,
      syncIncidents: body.syncIncidents ?? true,
      budgetAlerts: body.budgetAlerts ?? true,
      workflowPages: body.workflowPages ?? true,
    })
    .onConflictDoUpdate({
      target: [pushPreferences.userId, pushPreferences.organizationId],
      set: {
        ...(body.syncIncidents != null ? { syncIncidents: body.syncIncidents } : {}),
        ...(body.budgetAlerts != null ? { budgetAlerts: body.budgetAlerts } : {}),
        ...(body.workflowPages != null ? { workflowPages: body.workflowPages } : {}),
        updatedAt: now,
      },
    });

  await logAudit({
    organizationId,
    userId: session.userId,
    action: "push.preferences.update",
    entityType: "push_preferences",
    entityId: session.userId,
    metadata: {
      syncIncidents: body.syncIncidents,
      budgetAlerts: body.budgetAlerts,
      workflowPages: body.workflowPages,
    },
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
      syncIncidents: pushPreferences.syncIncidents,
      budgetAlerts: pushPreferences.budgetAlerts,
      workflowPages: pushPreferences.workflowPages,
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

  // Group devices per member; absent preference row means everything enabled.
  const byUser = new Map<
    string,
    {
      userId: string;
      email: string;
      displayName: string | null;
      syncIncidents: boolean;
      budgetAlerts: boolean;
      workflowPages: boolean;
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
        syncIncidents: r.syncIncidents ?? true,
        budgetAlerts: r.budgetAlerts ?? true,
        workflowPages: r.workflowPages ?? true,
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
