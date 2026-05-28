import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import crypto from "node:crypto";
import { db } from "../../db/client";
import { twilioRecipients, twilioSettings } from "../../db/schema";
import { encryptTwilioCredential, sendTestPage } from "@infrawrench/server-core/twilio-pager";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

// E.164: leading "+" then 1–15 digits.
const E164 = /^\+[1-9]\d{1,14}$/;

interface SettingsPayload {
  enabled: boolean;
  fromNumber: string | null;
  failureThreshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
  /** True iff Account SID + Auth Token are both stored. We never echo the values. */
  credentialsConfigured: boolean;
}

interface UpdateSettingsBody {
  enabled?: boolean;
  accountSid?: string;
  authToken?: string;
  fromNumber?: string | null;
  failureThreshold?: number;
  windowMinutes?: number;
  cooldownMinutes?: number;
}

app.get("/", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const [row] = await db
    .select()
    .from(twilioSettings)
    .where(eq(twilioSettings.organizationId, organizationId));

  const payload: SettingsPayload = row
    ? {
        enabled: row.enabled,
        fromNumber: row.fromNumber,
        failureThreshold: row.failureThreshold,
        windowMinutes: row.windowMinutes,
        cooldownMinutes: row.cooldownMinutes,
        credentialsConfigured: Boolean(row.encryptedAccountSid && row.encryptedAuthToken),
      }
    : {
        enabled: false,
        fromNumber: null,
        failureThreshold: 3,
        windowMinutes: 10,
        cooldownMinutes: 60,
        credentialsConfigured: false,
      };
  return c.json(payload);
});

app.put("/", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const body = await c.req.json<UpdateSettingsBody>();

  if (body.fromNumber != null && body.fromNumber !== "" && !E164.test(body.fromNumber)) {
    return c.json({ error: "fromNumber must be E.164 (e.g. +15551234567)" }, 400);
  }
  for (const [k, min] of [
    ["failureThreshold", 1],
    ["windowMinutes", 1],
    ["cooldownMinutes", 1],
  ] as const) {
    const v = body[k];
    if (v != null && (!Number.isInteger(v) || v < min)) {
      return c.json({ error: `${k} must be an integer >= ${min}` }, 400);
    }
  }

  const patch: Partial<typeof twilioSettings.$inferInsert> = { updatedAt: new Date() };
  if (body.enabled != null) patch.enabled = body.enabled;
  if (body.fromNumber !== undefined) patch.fromNumber = body.fromNumber || null;
  if (body.failureThreshold != null) patch.failureThreshold = body.failureThreshold;
  if (body.windowMinutes != null) patch.windowMinutes = body.windowMinutes;
  if (body.cooldownMinutes != null) patch.cooldownMinutes = body.cooldownMinutes;
  if (body.accountSid) {
    if (body.accountSid.length > 100)
      return c.json({ error: "accountSid is too long" }, 400);
    const enc = await encryptTwilioCredential(organizationId, "accountSid", body.accountSid.trim());
    patch.encryptedAccountSid = enc.ciphertext;
    patch.accountSidIv = enc.iv;
  }
  if (body.authToken) {
    if (body.authToken.length > 200) return c.json({ error: "authToken is too long" }, 400);
    const enc = await encryptTwilioCredential(organizationId, "authToken", body.authToken.trim());
    patch.encryptedAuthToken = enc.ciphertext;
    patch.authTokenIv = enc.iv;
  }

  await db
    .insert(twilioSettings)
    .values({
      organizationId,
      enabled: patch.enabled ?? false,
      encryptedAccountSid: patch.encryptedAccountSid ?? null,
      accountSidIv: patch.accountSidIv ?? null,
      encryptedAuthToken: patch.encryptedAuthToken ?? null,
      authTokenIv: patch.authTokenIv ?? null,
      fromNumber: patch.fromNumber ?? null,
      failureThreshold: patch.failureThreshold ?? 3,
      windowMinutes: patch.windowMinutes ?? 10,
      cooldownMinutes: patch.cooldownMinutes ?? 60,
    })
    .onConflictDoUpdate({
      target: twilioSettings.organizationId,
      set: patch,
    });

  return c.json({ ok: true });
});

app.get("/recipients", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const rows = await db
    .select()
    .from(twilioRecipients)
    .where(eq(twilioRecipients.organizationId, organizationId))
    .orderBy(twilioRecipients.createdAt);
  return c.json(
    rows.map((r) => ({
      id: r.id,
      displayName: r.displayName,
      phoneNumber: r.phoneNumber,
      sms: r.sms,
      voice: r.voice,
    })),
  );
});

interface RecipientBody {
  displayName: string;
  phoneNumber: string;
  sms?: boolean;
  voice?: boolean;
}

app.post("/recipients", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const body = await c.req.json<RecipientBody>();

  const displayName = body.displayName?.trim();
  const phoneNumber = body.phoneNumber?.trim();
  if (!displayName) return c.json({ error: "displayName is required" }, 400);
  if (!phoneNumber || !E164.test(phoneNumber)) {
    return c.json({ error: "phoneNumber must be E.164 (e.g. +15551234567)" }, 400);
  }
  const sms = body.sms ?? true;
  const voice = body.voice ?? true;
  if (!sms && !voice) {
    return c.json({ error: "Recipient must have SMS, voice, or both enabled" }, 400);
  }

  const id = crypto.randomUUID();
  await db.insert(twilioRecipients).values({
    id,
    organizationId,
    displayName,
    phoneNumber,
    sms,
    voice,
  });
  return c.json({ id, displayName, phoneNumber, sms, voice });
});

app.delete("/recipients/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const id = c.req.param("id");
  const result = await db
    .delete(twilioRecipients)
    .where(and(eq(twilioRecipients.id, id), eq(twilioRecipients.organizationId, organizationId)))
    .returning({ id: twilioRecipients.id });
  if (result.length === 0) return c.json({ error: "Recipient not found" }, 404);
  return c.json({ ok: true });
});

app.post("/test", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  try {
    const summary = await sendTestPage(organizationId);
    return c.json({ ok: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send test page";
    return c.json({ error: message }, 400);
  }
});

export { app as twilioRoutes };
