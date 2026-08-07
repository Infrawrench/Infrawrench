/**
 * Break-glass access requests (org-scoped, mounted at
 * /api/org/:orgId/access-requests).
 *
 * Asking takes `access:request`, seeing the queue takes `access:read`, and
 * deciding takes `access:approve` — deliberately not `team:role:write`.
 * Granting a role is a considered change with a paper trail; approving an
 * elevation happens mid-incident, and an org should be able to say who may do
 * the second without also saying who may do the first.
 *
 * Everything here is audit-logged, including denials and withdrawals. A
 * break-glass regime whose history is only "who got in" is missing the half a
 * reviewer actually asks about.
 */
import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@infrawrench/server-core/db/client";
import { users } from "@infrawrench/server-core/db/schema";
import {
  MAX_GRANT_MINUTES,
  MIN_GRANT_MINUTES,
  createAccessRequest,
  decideAccessRequest,
  getAccessRequest,
  listAccessRequests,
  revokeAccessGrant,
  withdrawAccessRequest,
  type AccessRequestStatus,
} from "@infrawrench/server-core/access/break-glass";
import { ALL_PERMISSIONS, hasPermission } from "@infrawrench/server-core/permissions/catalog";

import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

const app = new Hono();

function orgId(c: Context): string {
  return c.get("organizationId") as string;
}

function callerId(c: Context): string | undefined {
  return (c.get("session") as AuthSession | undefined)?.userId;
}

function callerPermissions(c: Context): readonly string[] {
  return (c.get("permissions") as string[] | undefined) ?? [];
}

async function callerName(userId: string): Promise<string | null> {
  const [user] = await db
    .select({ email: users.email, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user?.displayName ?? user?.email ?? null;
}

const STATUSES: AccessRequestStatus[] = ["pending", "approved", "denied", "expired"];

/**
 * GET / — the org's requests, newest first.
 *
 * `?mine=1` narrows to the caller's own, which is what a member without
 * `access:approve` actually wants: "where is my request".
 */
app.get("/", async (c) => {
  requirePermission(c, "access:read");
  const rawStatus = c.req.query("status");
  if (rawStatus !== undefined && !STATUSES.includes(rawStatus as AccessRequestStatus)) {
    return c.json({ error: `status must be one of: ${STATUSES.join(", ")}` }, 400);
  }
  const userId = callerId(c);
  const requests = await listAccessRequests(orgId(c), {
    ...(rawStatus ? { status: rawStatus as AccessRequestStatus } : {}),
    ...(c.req.query("mine") === "1" && userId ? { userId } : {}),
    ...(c.req.query("active") === "1" ? { activeOnly: true } : {}),
  });
  return c.json(requests);
});

/**
 * GET /catalog — the permission strings a request may ask for, and the limits.
 *
 * Served rather than hard-coded in the client so the picker cannot drift from
 * the server's catalog — the same reason the role editor reads it from here.
 */
app.get("/catalog", (c) => {
  requirePermission(c, "access:read");
  return c.json({
    permissions: [...ALL_PERMISSIONS],
    /** Permissions the caller already holds; the form greys these out. */
    held: ALL_PERMISSIONS.filter((p) => hasPermission(callerPermissions(c), p)),
    minGrantMinutes: MIN_GRANT_MINUTES,
    maxGrantMinutes: MAX_GRANT_MINUTES,
  });
});

const createSchema = z
  .object({
    permissions: z.array(z.string().min(1)).min(1).max(50),
    reason: z.string().min(10).max(2000),
    durationMinutes: z.number().int().min(MIN_GRANT_MINUTES).max(MAX_GRANT_MINUTES),
  })
  .strict();

/** POST / — ask for elevation. */
app.post("/", async (c) => {
  requirePermission(c, "access:request");
  const userId = callerId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, 400);
  }

  const result = await createAccessRequest(
    { organizationId: orgId(c), userId, ...parsed.data },
    callerPermissions(c),
  );
  if (result.outcome !== "created") return c.json({ error: result.error }, 400);

  await logAudit({
    organizationId: orgId(c),
    userId,
    action: "access_request.create",
    entityType: "access-request",
    entityId: result.request.id,
    metadata: {
      permissions: result.request.permissions,
      durationMinutes: result.request.durationMinutes,
      reason: result.request.reason,
    },
  });
  return c.json(result.request, 201);
});

const decideSchema = z.object({ note: z.string().max(1000).optional() }).strict();

async function decide(c: Context, decision: "approved" | "denied") {
  requirePermission(c, "access:approve");
  const userId = callerId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const requestId = c.req.param("id");
  if (!requestId) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const parsed = decideSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, 400);
  }

  const result = await decideAccessRequest(
    orgId(c),
    requestId,
    decision,
    {
      userId,
      name: await callerName(userId),
      // The decider's live set, which is the ceiling on what they can grant —
      // a grant can never mint authority nobody in the room had.
      permissions: callerPermissions(c),
    },
    { ...(parsed.data.note ? { note: parsed.data.note } : {}) },
  );

  if (result.outcome === "not_found") return c.json({ error: "Not found" }, 404);
  if (result.outcome === "self_approval") {
    return c.json(
      {
        error:
          "You cannot decide your own access request — that is the whole point of the approval.",
        code: "self_approval",
      },
      403,
    );
  }
  if (result.outcome === "exceeds_approver") {
    return c.json(
      {
        error:
          `You cannot grant permissions you do not hold yourself: ` +
          `${result.missing.join(", ")}.`,
        code: "exceeds_approver",
        missing: result.missing,
      },
      403,
    );
  }
  if (result.outcome === "conflict") {
    return c.json({ error: "This request has already been decided or has expired." }, 409);
  }

  await logAudit({
    organizationId: orgId(c),
    userId,
    action: decision === "approved" ? "access_request.approve" : "access_request.deny",
    entityType: "access-request",
    entityId: requestId,
    metadata: {
      requesterUserId: result.request.userId,
      permissions: result.request.permissions,
      durationMinutes: result.request.durationMinutes,
      grantExpiresAt: result.request.grantExpiresAt,
      ...(result.request.decisionNote ? { note: result.request.decisionNote } : {}),
    },
  });
  return c.json(result.request);
}

app.post("/:id/approve", (c) => decide(c, "approved"));
app.post("/:id/deny", (c) => decide(c, "denied"));

/**
 * POST /:id/revoke — end a live grant early.
 *
 * Allowed for anyone with `access:approve` **and** for the holder: giving back
 * an elevation you no longer need must never require finding an approver.
 */
app.post("/:id/revoke", async (c) => {
  const userId = callerId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const requestId = c.req.param("id");
  if (!requestId) return c.json({ error: "Not found" }, 404);

  const existing = await getAccessRequest(orgId(c), requestId);
  if (!existing) return c.json({ error: "Not found" }, 404);
  if (existing.userId !== userId) requirePermission(c, "access:approve");

  const result = await revokeAccessGrant(orgId(c), requestId, {
    userId,
    name: await callerName(userId),
  });
  if (result.outcome === "not_found") return c.json({ error: "Not found" }, 404);
  if (result.outcome === "not_active") {
    return c.json({ error: "This grant is not active." }, 409);
  }

  await logAudit({
    organizationId: orgId(c),
    userId,
    action: "access_request.revoke",
    entityType: "access-request",
    entityId: requestId,
    metadata: {
      holderUserId: result.request.userId,
      permissions: result.request.permissions,
      selfRevoked: result.request.userId === userId,
    },
  });
  return c.json(result.request);
});

/** POST /:id/withdraw — the requester calls off their own pending request. */
app.post("/:id/withdraw", async (c) => {
  requirePermission(c, "access:request");
  const userId = callerId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const requestId = c.req.param("id");
  if (!requestId) return c.json({ error: "Not found" }, 404);

  const result = await withdrawAccessRequest(orgId(c), requestId, userId);
  if (result.outcome === "not_found") return c.json({ error: "Not found" }, 404);
  if (result.outcome === "conflict") {
    return c.json({ error: "This request has already been decided or has expired." }, 409);
  }

  await logAudit({
    organizationId: orgId(c),
    userId,
    action: "access_request.withdraw",
    entityType: "access-request",
    entityId: requestId,
    metadata: {},
  });
  return c.json({ ok: true });
});

export default app;
