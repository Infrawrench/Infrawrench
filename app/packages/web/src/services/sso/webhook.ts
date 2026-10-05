/**
 * WorkOS webhook verification and dispatch.
 *
 * Verification is done here over the **raw** request body rather than through
 * the SDK's `constructEvent`, which re-serialises a parsed object with
 * `JSON.stringify` and compares against that: correct only while WorkOS's
 * bytes happen to round-trip identically. The scheme is WorkOS's documented
 * one: header `WorkOS-Signature: t=<ms>, v1=<hex>`, HMAC-SHA256 keyed with
 * the endpoint secret over `<t>.<raw body>`.
 *
 * Replay is closed from both sides: the timestamp must be within
 * {@link TOLERANCE_MS} of now (in either direction, unlike the SDK's
 * past-only check), and each event id is recorded so a redelivery inside the
 * window is acknowledged without being processed twice.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db } from "../../db/client";
import { ssoGroupRoleMappings, workosWebhookEvents } from "../../db/schema";
import { logAudit } from "../audit";
import { deprovisionDirectoryUser, syncDirectoryUser } from "./directory-sync";
import { updateSsoSettings, type SsoSettingsRow } from "./settings";
import * as wos from "./workos-api";

export const TOLERANCE_MS = 5 * 60 * 1000;
/** Event ids are kept well past the tolerance window; anything older is unreplayable anyway. */
const EVENT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

export function verifyWorkosSignature(
  rawBody: string,
  header: string | undefined | null,
  secret: string,
  now: number = Date.now(),
): boolean {
  if (!header || !secret) return false;
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, ...rest] = part.trim().split("=");
    const v = rest.join("=");
    if (k === "t") timestamp = v;
    else if (k === "v1" && v) signatures.push(v);
  }
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > TOLERANCE_MS) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  return signatures.some((sig) => {
    const buf = Buffer.from(sig, "utf8");
    return buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf);
  });
}

export interface WorkosWebhookEvent {
  id: string;
  event: string;
  data: Record<string, unknown>;
}

export function parseWorkosEvent(rawBody: string): WorkosWebhookEvent | null {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    if (typeof parsed["id"] !== "string" || typeof parsed["event"] !== "string") return null;
    const data = parsed["data"];
    if (!data || typeof data !== "object") return null;
    return { id: parsed["id"], event: parsed["event"], data: data as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * Record an event id; false when it was already recorded (a redelivery).
 * Old ids are swept opportunistically on the same write path.
 */
export async function claimEvent(
  event: WorkosWebhookEvent,
  orgId: string | null,
): Promise<boolean> {
  const inserted = await db
    .insert(workosWebhookEvents)
    .values({ id: event.id, eventType: event.event, organizationId: orgId })
    .onConflictDoNothing()
    .returning({ id: workosWebhookEvents.id });
  if (Math.random() < 0.02) {
    void db
      .delete(workosWebhookEvents)
      .where(lt(workosWebhookEvents.receivedAt, new Date(Date.now() - EVENT_RETENTION_MS)))
      .catch((err: unknown) => console.error("[workos-webhook] sweeping event ids failed:", err));
  }
  return inserted.length > 0;
}

/** Forget an event id so WorkOS's retry is processed (used when handling failed). */
export async function releaseEvent(eventId: string): Promise<void> {
  await db.delete(workosWebhookEvents).where(eq(workosWebhookEvents.id, eventId));
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/** The WorkOS organization an event concerns, by whatever field this event type carries. */
export async function eventWorkosOrgId(event: WorkosWebhookEvent): Promise<string | null> {
  const d = event.data;
  const direct =
    str(d["organization_id"]) ??
    str(obj(d["user"])?.["organization_id"]) ??
    str(obj(d["group"])?.["organization_id"]);
  if (direct) return direct;
  const directoryId = str(d["directory_id"]);
  if (directoryId) return await wos.directoryOrganizationId(directoryId);
  return null;
}

/** Resync one directory user from WorkOS's current view of them. */
async function resyncUser(settings: SsoSettingsRow, directoryUserId: string): Promise<void> {
  let fresh: wos.WorkosDirectoryUser;
  try {
    fresh = await wos.getDirectoryUser(directoryUserId);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) {
      await deprovisionDirectoryUser(settings, directoryUserId, "webhook");
      return;
    }
    throw err;
  }
  // Cross-org guard: the user must belong to the org the event was routed to.
  if (fresh.organizationId && fresh.organizationId !== settings.workosOrganizationId) return;
  await syncDirectoryUser(settings, fresh, "webhook");
}

async function refreshVerifiedDomains(settings: SsoSettingsRow): Promise<void> {
  const domains = await wos.listDomains(settings.workosOrganizationId);
  await updateSsoSettings(settings.organizationId, {
    verifiedDomains: domains.filter((d) => d.state === "verified").map((d) => d.domain),
  });
}

/** Act on one verified, first-seen event. Throws to ask WorkOS to retry. */
export async function handleWorkosEvent(
  settings: SsoSettingsRow,
  event: WorkosWebhookEvent,
): Promise<void> {
  const d = event.data;
  const organizationId = settings.organizationId;
  switch (event.event) {
    case "dsync.user.created":
    case "dsync.user.updated": {
      const id = str(d["id"]);
      if (id) await resyncUser(settings, id);
      return;
    }
    case "dsync.user.deleted": {
      const id = str(d["id"]);
      if (id) await deprovisionDirectoryUser(settings, id, "webhook");
      return;
    }
    case "dsync.group.user_added":
    case "dsync.group.user_removed": {
      const id = str(obj(d["user"])?.["id"]);
      if (id) await resyncUser(settings, id);
      return;
    }
    case "dsync.group.updated": {
      const id = str(d["id"]);
      const name = str(d["name"]);
      if (id && name) {
        await db
          .update(ssoGroupRoleMappings)
          .set({ groupName: name, updatedAt: new Date() })
          .where(
            and(
              eq(ssoGroupRoleMappings.organizationId, organizationId),
              eq(ssoGroupRoleMappings.directoryGroupId, id),
            ),
          );
      }
      return;
    }
    case "dsync.group.deleted": {
      // A mapping to a group that no longer exists can never match again;
      // removing it keeps the table honest. Members fall back to the default
      // role at their next sync, exactly as if they had left the group.
      const id = str(d["id"]);
      if (!id) return;
      const removed = await db
        .delete(ssoGroupRoleMappings)
        .where(
          and(
            eq(ssoGroupRoleMappings.organizationId, organizationId),
            eq(ssoGroupRoleMappings.directoryGroupId, id),
          ),
        )
        .returning({ id: ssoGroupRoleMappings.id });
      if (removed.length > 0) {
        void logAudit({
          organizationId,
          action: "sso.mapping_delete",
          entityType: "sso",
          entityId: removed[0]!.id,
          metadata: { reason: "directory_group_deleted", directoryGroupId: id },
        });
      }
      return;
    }
    case "dsync.activated":
    case "dsync.deleted": {
      // Deleting a directory does not remove anybody: WorkOS sends no
      // per-user events for it, and reading "the directory is gone" as
      // "everybody left" would empty the org on a reconfiguration. The rows
      // are kept, and the page shows the directory as gone.
      void logAudit({
        organizationId,
        action: "sso.directory_change",
        entityType: "sso",
        entityId: str(d["id"]) ?? organizationId,
        metadata: { event: event.event, type: str(d["type"]), state: str(d["state"]) },
      });
      return;
    }
    case "connection.activated":
    case "connection.deactivated":
    case "connection.deleted": {
      void logAudit({
        organizationId,
        action: "sso.connection_change",
        entityType: "sso",
        entityId: str(d["id"]) ?? organizationId,
        metadata: {
          event: event.event,
          connectionType: str(d["connection_type"]),
          state: str(d["state"]),
        },
      });
      return;
    }
    case "organization_domain.created":
    case "organization_domain.updated":
    case "organization_domain.deleted":
    case "organization_domain.verified":
    case "organization_domain.verification_failed": {
      await refreshVerifiedDomains(settings);
      if (event.event === "organization_domain.verified") {
        void logAudit({
          organizationId,
          action: "sso.domain_verify",
          entityType: "sso",
          entityId: str(d["id"]) ?? organizationId,
          metadata: { domain: str(d["domain"]), source: "webhook" },
        });
      }
      return;
    }
    default:
      return;
  }
}
