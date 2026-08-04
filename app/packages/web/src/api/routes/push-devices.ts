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
  anomalyAlerts: boolean;
  metricAlerts: boolean;
  resourceDrift: boolean;
  workflowPages: boolean;
  providerIncidents: boolean;
  expiryAlerts: boolean;
  logMatchAlerts: boolean;
  postureAlerts: boolean;
}

const PREFERENCE_KEYS = [
  "syncIncidents",
  "budgetAlerts",
  "anomalyAlerts",
  "metricAlerts",
  "resourceDrift",
  "workflowPages",
  "providerIncidents",
  "expiryAlerts",
  "logMatchAlerts",
  "postureAlerts",
] as const;

/**
 * What an absent preference row (or an absent field on a PUT) means per
 * trigger. Everything is on by default except resource drift, which is
 * continuous rather than exceptional — see `db/schema.ts`.
 */
const PREFERENCE_DEFAULTS: PreferencesPayload = {
  syncIncidents: true,
  budgetAlerts: true,
  anomalyAlerts: true,
  metricAlerts: true,
  resourceDrift: false,
  workflowPages: true,
  providerIncidents: true,
  expiryAlerts: true,
  logMatchAlerts: true,
  postureAlerts: true,
};

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
    syncIncidents: row?.syncIncidents ?? PREFERENCE_DEFAULTS.syncIncidents,
    budgetAlerts: row?.budgetAlerts ?? PREFERENCE_DEFAULTS.budgetAlerts,
    anomalyAlerts: row?.anomalyAlerts ?? PREFERENCE_DEFAULTS.anomalyAlerts,
    metricAlerts: row?.metricAlerts ?? PREFERENCE_DEFAULTS.metricAlerts,
    resourceDrift: row?.resourceDrift ?? PREFERENCE_DEFAULTS.resourceDrift,
    workflowPages: row?.workflowPages ?? PREFERENCE_DEFAULTS.workflowPages,
    providerIncidents: row?.providerIncidents ?? PREFERENCE_DEFAULTS.providerIncidents,
    expiryAlerts: row?.expiryAlerts ?? PREFERENCE_DEFAULTS.expiryAlerts,
    logMatchAlerts: row?.logMatchAlerts ?? PREFERENCE_DEFAULTS.logMatchAlerts,
    postureAlerts: row?.postureAlerts ?? PREFERENCE_DEFAULTS.postureAlerts,
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
      syncIncidents: body.syncIncidents ?? PREFERENCE_DEFAULTS.syncIncidents,
      budgetAlerts: body.budgetAlerts ?? PREFERENCE_DEFAULTS.budgetAlerts,
      anomalyAlerts: body.anomalyAlerts ?? PREFERENCE_DEFAULTS.anomalyAlerts,
      metricAlerts: body.metricAlerts ?? PREFERENCE_DEFAULTS.metricAlerts,
      resourceDrift: body.resourceDrift ?? PREFERENCE_DEFAULTS.resourceDrift,
      workflowPages: body.workflowPages ?? PREFERENCE_DEFAULTS.workflowPages,
      providerIncidents: body.providerIncidents ?? PREFERENCE_DEFAULTS.providerIncidents,
      expiryAlerts: body.expiryAlerts ?? PREFERENCE_DEFAULTS.expiryAlerts,
      logMatchAlerts: body.logMatchAlerts ?? PREFERENCE_DEFAULTS.logMatchAlerts,
      postureAlerts: body.postureAlerts ?? PREFERENCE_DEFAULTS.postureAlerts,
    })
    .onConflictDoUpdate({
      target: [pushPreferences.userId, pushPreferences.organizationId],
      set: {
        ...(body.syncIncidents != null ? { syncIncidents: body.syncIncidents } : {}),
        ...(body.budgetAlerts != null ? { budgetAlerts: body.budgetAlerts } : {}),
        ...(body.anomalyAlerts != null ? { anomalyAlerts: body.anomalyAlerts } : {}),
        ...(body.metricAlerts != null ? { metricAlerts: body.metricAlerts } : {}),
        ...(body.resourceDrift != null ? { resourceDrift: body.resourceDrift } : {}),
        ...(body.workflowPages != null ? { workflowPages: body.workflowPages } : {}),
        ...(body.providerIncidents != null ? { providerIncidents: body.providerIncidents } : {}),
        ...(body.expiryAlerts != null ? { expiryAlerts: body.expiryAlerts } : {}),
        ...(body.logMatchAlerts != null ? { logMatchAlerts: body.logMatchAlerts } : {}),
        ...(body.postureAlerts != null ? { postureAlerts: body.postureAlerts } : {}),
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
      anomalyAlerts: body.anomalyAlerts,
      metricAlerts: body.metricAlerts,
      resourceDrift: body.resourceDrift,
      workflowPages: body.workflowPages,
      providerIncidents: body.providerIncidents,
      expiryAlerts: body.expiryAlerts,
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
      anomalyAlerts: pushPreferences.anomalyAlerts,
      metricAlerts: pushPreferences.metricAlerts,
      resourceDrift: pushPreferences.resourceDrift,
      workflowPages: pushPreferences.workflowPages,
      providerIncidents: pushPreferences.providerIncidents,
      expiryAlerts: pushPreferences.expiryAlerts,
      logMatchAlerts: pushPreferences.logMatchAlerts,
      postureAlerts: pushPreferences.postureAlerts,
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
      anomalyAlerts: boolean;
      metricAlerts: boolean;
      resourceDrift: boolean;
      workflowPages: boolean;
      providerIncidents: boolean;
      expiryAlerts: boolean;
      logMatchAlerts: boolean;
      postureAlerts: boolean;
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
        syncIncidents: r.syncIncidents ?? PREFERENCE_DEFAULTS.syncIncidents,
        budgetAlerts: r.budgetAlerts ?? PREFERENCE_DEFAULTS.budgetAlerts,
        anomalyAlerts: r.anomalyAlerts ?? PREFERENCE_DEFAULTS.anomalyAlerts,
        metricAlerts: r.metricAlerts ?? PREFERENCE_DEFAULTS.metricAlerts,
        resourceDrift: r.resourceDrift ?? PREFERENCE_DEFAULTS.resourceDrift,
        workflowPages: r.workflowPages ?? PREFERENCE_DEFAULTS.workflowPages,
        providerIncidents: r.providerIncidents ?? PREFERENCE_DEFAULTS.providerIncidents,
        expiryAlerts: r.expiryAlerts ?? PREFERENCE_DEFAULTS.expiryAlerts,
        logMatchAlerts: r.logMatchAlerts ?? PREFERENCE_DEFAULTS.logMatchAlerts,
        postureAlerts: r.postureAlerts ?? PREFERENCE_DEFAULTS.postureAlerts,
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
