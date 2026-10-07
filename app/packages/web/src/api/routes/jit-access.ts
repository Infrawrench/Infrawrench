/**
 * Just-in-time access (org-scoped, mounted at /api/org/:orgId/jit-access).
 *
 * Time-boxed **provider** roles under admin-written policies. Not break-glass
 * (`access-requests.ts`), which elevates Infrawrench permissions.
 *
 * Route-level permissions are the floor, not the rule: reading takes
 * `access:read`, asking `access:request`, editing policies
 * `org:settings:write`. Who may *decide* is the policy's approver set, which
 * the service evaluates at decision time (`server-core/jit-access/service.ts`);
 * the route only requires `access:read` to get that far. The service also
 * owns every audit row, so the Slack button and this route record the same
 * thing.
 *
 * API keys cannot decide, extend or (at the route level) revoke: see
 * `API_KEY_DENY_RULES`. Approving a grant of cloud access is a person's call.
 *
 * Mutations here call plugin code (grant, revoke, the pickers), so the whole
 * prefix is in `MUTATIONS_ON_GATEWAY`; the picker GETs fall back to the
 * gateway on their own.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";

import {
  JitAccessError,
  cancelJitRequest,
  createJitPolicy,
  createJitRequest,
  decideJitRequest,
  deleteJitPolicy,
  extendJitRequest,
  getJitPolicy,
  getJitRequest,
  listJitAccounts,
  listJitPolicies,
  listJitPrincipalsForPolicy,
  listJitRequests,
  listJitRoleOptions,
  listJitScopeOptions,
  loadJitCaller,
  resolveJitPrincipalForCaller,
  revokeJitRequest,
  updateJitPolicy,
  type JitCaller,
} from "@infrawrench/server-core/jit-access/service";
import { JIT_LIMITS, JIT_REQUEST_STATUSES, type JitRequestStatus } from "@infrawrench/client-core";

import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

const app = new Hono();

function orgId(c: Context): string {
  return c.get("organizationId") as string;
}

async function caller(c: Context): Promise<JitCaller | null> {
  const userId = (c.get("session") as AuthSession | undefined)?.userId;
  if (!userId) return null;
  const permissions = (c.get("permissions") as string[] | undefined) ?? [];
  return loadJitCaller(orgId(c), userId, permissions);
}

/** Where a decision came from, for the audit row; clients may say which app. */
function via(c: Context): string {
  const client = c.req.header("x-infrawrench-client");
  if (client === "mobile") return "the mobile app";
  if (client === "cli") return "the CLI";
  if (client === "desktop") return "the desktop app";
  // The browser authenticates with a session cookie; everything else (the
  // desktop proxy, mobile, the CLI) presents a bearer token.
  if (c.req.header("authorization")?.toLowerCase().startsWith("bearer ")) {
    return "a signed-in app (desktop, mobile or the CLI)";
  }
  return "the web app";
}

function fail(c: Context, err: unknown) {
  if (err instanceof JitAccessError) {
    return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
  }
  throw err;
}

/* ---- accounts and pickers ---- */

app.get("/accounts", async (c) => {
  requirePermission(c, "access:read");
  return c.json(await listJitAccounts(orgId(c)));
});

app.get("/accounts/:accountId/scopes", async (c) => {
  requirePermission(c, "org:settings:write");
  try {
    return c.json(await listJitScopeOptions(orgId(c), c.req.param("accountId")));
  } catch (err) {
    return fail(c, err);
  }
});

app.get("/accounts/:accountId/roles", async (c) => {
  requirePermission(c, "org:settings:write");
  const scopeId = c.req.query("scopeId");
  if (!scopeId) return c.json({ error: "scopeId is required" }, 400);
  try {
    return c.json(await listJitRoleOptions(orgId(c), c.req.param("accountId"), scopeId));
  } catch (err) {
    return fail(c, err);
  }
});

/* ---- policies ---- */

const idList = z.array(z.string().min(1).max(200)).max(200).optional();

const policySchema = z
  .object({
    name: z.string().trim().min(1).max(JIT_LIMITS.maxNameLength),
    description: z.string().max(JIT_LIMITS.maxDescriptionLength).nullable().optional(),
    enabled: z.boolean().optional(),
    accountId: z.string().min(1),
    targets: z
      .array(
        z
          .object({
            scopeId: z.string().min(1).max(1224),
            scopeName: z.string().max(300),
            roleId: z.string().min(1).max(1224),
            roleName: z.string().max(300),
          })
          .strict(),
      )
      .min(1)
      .max(JIT_LIMITS.maxTargets),
    maxDurationMinutes: z
      .number()
      .int()
      .min(JIT_LIMITS.minDurationMinutes)
      .max(JIT_LIMITS.maxDurationMinutes),
    defaultDurationMinutes: z
      .number()
      .int()
      .min(JIT_LIMITS.minDurationMinutes)
      .max(JIT_LIMITS.maxDurationMinutes)
      .optional(),
    requestTimeoutMinutes: z
      .number()
      .int()
      .min(JIT_LIMITS.minTimeoutMinutes)
      .max(JIT_LIMITS.maxTimeoutMinutes)
      .optional(),
    requesterUserIds: idList,
    requesterRoleIds: idList,
    approverUserIds: idList,
    approverRoleIds: idList,
    approverOnCallScheduleIds: idList,
    allowSelfApprovalDuringIncident: z.boolean().optional(),
    requireReason: z.boolean().optional(),
    requireTicket: z.boolean().optional(),
  })
  .strict();

app.get("/policies", async (c) => {
  requirePermission(c, "access:read");
  const who = await caller(c);
  return c.json(await listJitPolicies(orgId(c), who ?? undefined));
});

app.get("/policies/:id", async (c) => {
  requirePermission(c, "access:read");
  const who = await caller(c);
  const policy = await getJitPolicy(orgId(c), c.req.param("id"), who ?? undefined);
  if (!policy) return c.json({ error: "Not found" }, 404);
  return c.json(policy);
});

async function writePolicy(c: Context, policyId: string | null) {
  requirePermission(c, "org:settings:write");
  const parsed = policySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, 400);
  }
  const userId = (c.get("session") as AuthSession | undefined)?.userId ?? null;
  try {
    const policy = policyId
      ? await updateJitPolicy(orgId(c), policyId, parsed.data)
      : await createJitPolicy(orgId(c), parsed.data, userId);
    if (!policy) return c.json({ error: "Not found" }, 404);
    void logAudit({
      organizationId: orgId(c),
      userId: userId ?? undefined,
      action: policyId ? "jit_access.policy.update" : "jit_access.policy.create",
      entityType: "jit-access-policy",
      entityId: policy.id,
      metadata: {
        name: policy.name,
        accountId: policy.accountId,
        targets: policy.targets.map((t) => `${t.roleName} on ${t.scopeName}`),
        maxDurationMinutes: policy.maxDurationMinutes,
        approverUserIds: policy.approverUserIds,
        approverRoleIds: policy.approverRoleIds,
        approverOnCallScheduleIds: policy.approverOnCallScheduleIds,
        allowSelfApprovalDuringIncident: policy.allowSelfApprovalDuringIncident,
        enabled: policy.enabled,
      },
    });
    return c.json(policy, policyId ? 200 : 201);
  } catch (err) {
    return fail(c, err);
  }
}

app.post("/policies", (c) => writePolicy(c, null));
app.put("/policies/:id", (c) => writePolicy(c, c.req.param("id")));

app.delete("/policies/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const id = c.req.param("id");
  const existing = await getJitPolicy(orgId(c), id);
  if (!existing || !(await deleteJitPolicy(orgId(c), id))) {
    return c.json({ error: "Not found" }, 404);
  }
  void logAudit({
    organizationId: orgId(c),
    userId: (c.get("session") as AuthSession | undefined)?.userId,
    action: "jit_access.policy.delete",
    entityType: "jit-access-policy",
    entityId: id,
    metadata: { name: existing.name, accountId: existing.accountId },
  });
  return c.json({ ok: true });
});

app.get("/policies/:id/principal", async (c) => {
  requirePermission(c, "access:request");
  const who = await caller(c);
  if (!who) return c.json({ error: "Unauthorized" }, 401);
  try {
    return c.json(await resolveJitPrincipalForCaller(orgId(c), c.req.param("id"), who));
  } catch (err) {
    return fail(c, err);
  }
});

app.get("/policies/:id/principals", async (c) => {
  requirePermission(c, "access:request");
  const who = await caller(c);
  if (!who) return c.json({ error: "Unauthorized" }, 401);
  try {
    const q = c.req.query("q")?.slice(0, 200);
    return c.json(await listJitPrincipalsForPolicy(orgId(c), c.req.param("id"), who, q));
  } catch (err) {
    return fail(c, err);
  }
});

/* ---- requests ---- */

app.get("/requests", async (c) => {
  requirePermission(c, "access:read");
  const who = await caller(c);
  if (!who) return c.json({ error: "Unauthorized" }, 401);
  const rawStatus = c.req.query("status");
  if (rawStatus !== undefined && !JIT_REQUEST_STATUSES.includes(rawStatus as JitRequestStatus)) {
    return c.json({ error: `status must be one of: ${JIT_REQUEST_STATUSES.join(", ")}` }, 400);
  }
  return c.json(
    await listJitRequests(orgId(c), who, {
      ...(rawStatus ? { status: rawStatus as JitRequestStatus } : {}),
      ...(c.req.query("mine") === "1" ? { mine: true } : {}),
      ...(c.req.query("holding") === "1" ? { holding: true } : {}),
    }),
  );
});

app.get("/requests/:id", async (c) => {
  requirePermission(c, "access:read");
  const who = await caller(c);
  if (!who) return c.json({ error: "Unauthorized" }, 401);
  const request = await getJitRequest(orgId(c), c.req.param("id"), who);
  if (!request) return c.json({ error: "Not found" }, 404);
  return c.json(request);
});

const createSchema = z
  .object({
    policyId: z.string().min(1),
    scopeId: z.string().min(1).max(1224),
    roleId: z.string().min(1).max(1224),
    durationMinutes: z
      .number()
      .int()
      .min(JIT_LIMITS.minDurationMinutes)
      .max(JIT_LIMITS.maxDurationMinutes),
    reason: z.string().max(JIT_LIMITS.maxReasonLength),
    ticket: z.string().max(JIT_LIMITS.maxTicketLength).optional(),
    principalId: z.string().min(1).max(500).optional(),
  })
  .strict();

app.post("/requests", async (c) => {
  requirePermission(c, "access:request");
  const who = await caller(c);
  if (!who) return c.json({ error: "Unauthorized" }, 401);
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, 400);
  }
  try {
    return c.json(await createJitRequest(orgId(c), parsed.data, who, via(c)), 201);
  } catch (err) {
    return fail(c, err);
  }
});

const noteSchema = z.object({ note: z.string().max(1000).optional() }).strict();

async function decide(c: Context, decision: "approve" | "deny") {
  requirePermission(c, "access:read");
  const who = await caller(c);
  if (!who) return c.json({ error: "Unauthorized" }, 401);
  const parsed = noteSchema.safeParse((await c.req.json().catch(() => ({}))) ?? {});
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, 400);
  }
  try {
    return c.json(
      await decideJitRequest(orgId(c), c.req.param("id")!, decision, who, {
        note: parsed.data.note ?? null,
        via: via(c),
      }),
    );
  } catch (err) {
    return fail(c, err);
  }
}

app.post("/requests/:id/approve", (c) => decide(c, "approve"));
app.post("/requests/:id/deny", (c) => decide(c, "deny"));

app.post("/requests/:id/cancel", async (c) => {
  requirePermission(c, "access:request");
  const who = await caller(c);
  if (!who) return c.json({ error: "Unauthorized" }, 401);
  try {
    return c.json(await cancelJitRequest(orgId(c), c.req.param("id"), who, via(c)));
  } catch (err) {
    return fail(c, err);
  }
});

const extendSchema = z
  .object({ minutes: z.number().int().min(1).max(JIT_LIMITS.maxDurationMinutes) })
  .strict();

app.post("/requests/:id/extend", async (c) => {
  requirePermission(c, "access:read");
  const who = await caller(c);
  if (!who) return c.json({ error: "Unauthorized" }, 401);
  const parsed = extendSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, 400);
  }
  try {
    return c.json(
      await extendJitRequest(orgId(c), c.req.param("id"), parsed.data.minutes, who, via(c)),
    );
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * POST /requests/:id/revoke: end a grant early. Allowed for the holder, an
 * approver, or anyone with `org:settings:write`; the service owns that check
 * (the break-glass revoke precedent: the permission depends on who is asking).
 */
app.post("/requests/:id/revoke", async (c) => {
  const who = await caller(c);
  if (!who) return c.json({ error: "Unauthorized" }, 401);
  try {
    return c.json(await revokeJitRequest(orgId(c), c.req.param("id"), who, via(c)));
  } catch (err) {
    return fail(c, err);
  }
});

export default app;
