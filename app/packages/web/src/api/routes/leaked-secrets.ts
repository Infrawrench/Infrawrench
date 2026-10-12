/**
 * Leaked credentials (`/api/org/:orgId/leaked-secrets/*`): secrets a scanner
 * plugin found committed to code, and the actions that close them.
 *
 * Reading is `resources:read`, the posture stance (the list shows where a
 * secret leaked and a four-character hint, never the value). Every action is
 * `secrets:write`: rotating reissues or replaces a stored secret, and
 * dismissing decides one does not need it. Mutations are gateway-routed
 * (`edge/gateway-routes.ts`) because they call plugin code.
 *
 * The server half lives in `server-core/src/leaked-secrets/`.
 */
import { Hono, type Context } from "hono";
import {
  LEAKED_SECRET_STATUSES,
  type LeakDismissReason,
  type LeakedSecretStatus,
} from "@infrawrench/client-core";
import {
  LeakedSecretError,
  dismissLeak,
  markLeakRotated,
  reopenLeak,
  rotateLeak,
} from "@infrawrench/server-core/leaked-secrets/actions";
import { listLeakedSecrets } from "@infrawrench/server-core/leaked-secrets/store";
import { scanOrgLeakedSecretsNow } from "@infrawrench/server-core/leaked-secrets/scan";

import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";
import { readObjectBody } from "../object-body";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

const DISMISS_REASONS: readonly LeakDismissReason[] = [
  "false-positive",
  "wont-fix",
  "used-in-tests",
];

function fail(c: Context, err: unknown): Response {
  if (err instanceof LeakedSecretError) return c.json({ error: err.message }, err.status);
  throw err;
}

function actor(c: Context) {
  const session = c.get("session");
  return { userId: session?.userId ?? null, userLabel: session?.email ?? null };
}

function optionalBool(v: unknown): boolean | undefined | null {
  if (v === undefined) return undefined;
  return typeof v === "boolean" ? v : null;
}

app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  const status = c.req.query("status");
  if (status && !LEAKED_SECRET_STATUSES.includes(status as LeakedSecretStatus)) {
    return c.json({ error: "Unknown status" }, 400);
  }
  const accountId = c.req.query("accountId");
  return c.json(
    await listLeakedSecrets(c.get("organizationId"), {
      ...(status ? { status: status as LeakedSecretStatus } : {}),
      ...(accountId ? { accountId } : {}),
    }),
  );
});

app.post("/scan", async (c) => {
  requirePermission(c, "secrets:write");
  return c.json(await scanOrgLeakedSecretsNow(c.get("organizationId")));
});

function audit(c: Context, action: string, leak: { id: string; tokenType: string }, extra = {}) {
  void logAudit({
    organizationId: c.get("organizationId"),
    userId: c.get("session")?.userId ?? null,
    action: `leaked_secret.${action}`,
    entityType: "leaked-secret",
    entityId: leak.id,
    metadata: { tokenType: leak.tokenType, ...extra },
  });
}

app.post("/:id/rotate", async (c) => {
  requirePermission(c, "secrets:write");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const value = parsed.body["value"];
  if (value !== undefined && typeof value !== "string") {
    return c.json({ error: "value must be a string" }, 400);
  }
  const resolveUpstream = optionalBool(parsed.body["resolveUpstream"]);
  if (resolveUpstream === null) return c.json({ error: "resolveUpstream must be a boolean" }, 400);
  try {
    const leak = await rotateLeak(
      c.get("organizationId"),
      c.req.param("id"),
      { value, resolveUpstream },
      actor(c),
    );
    // Never the value: only how it was rotated.
    audit(c, "rotated", leak, { method: leak.rotationMethod, matchKind: leak.matchKind });
    return c.json({ leak });
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/:id/mark-rotated", async (c) => {
  requirePermission(c, "secrets:write");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const resolveUpstream = optionalBool(parsed.body["resolveUpstream"]);
  if (resolveUpstream === null) return c.json({ error: "resolveUpstream must be a boolean" }, 400);
  try {
    const leak = await markLeakRotated(
      c.get("organizationId"),
      c.req.param("id"),
      { resolveUpstream },
      actor(c),
    );
    audit(c, "rotated", leak, { method: "manual" });
    return c.json({ leak });
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/:id/dismiss", async (c) => {
  requirePermission(c, "secrets:write");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const reason = parsed.body["reason"];
  if (typeof reason !== "string" || !DISMISS_REASONS.includes(reason as LeakDismissReason)) {
    return c.json({ error: "reason must be false-positive, wont-fix or used-in-tests" }, 400);
  }
  const comment = parsed.body["comment"];
  if (comment !== undefined && typeof comment !== "string") {
    return c.json({ error: "comment must be a string" }, 400);
  }
  const resolveUpstream = optionalBool(parsed.body["resolveUpstream"]);
  if (resolveUpstream === null) return c.json({ error: "resolveUpstream must be a boolean" }, 400);
  try {
    const leak = await dismissLeak(
      c.get("organizationId"),
      c.req.param("id"),
      { reason: reason as LeakDismissReason, comment, resolveUpstream },
      actor(c),
    );
    audit(c, "dismissed", leak, { reason });
    return c.json({ leak });
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/:id/reopen", async (c) => {
  requirePermission(c, "secrets:write");
  try {
    const leak = await reopenLeak(c.get("organizationId"), c.req.param("id"));
    audit(c, "reopened", leak);
    return c.json({ leak });
  } catch (err) {
    return fail(c, err);
  }
});

export { app as leakedSecretRoutes };
