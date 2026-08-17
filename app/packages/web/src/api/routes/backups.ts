/**
 * Backup coverage routes (`/api/org/:orgId/backups*`).
 *
 * The coverage is assembled in server-core (`backups/feed.ts`) so the web API
 * and the weekly digest share one computation. Purely a read over
 * already-synced state: no provider API calls.
 *
 * The read takes `resources:read` — it is a view of the org's inventory — while
 * the policies take `org:settings:write`, the posture-settings stance: a
 * recovery objective is an org-wide statement about what the organisation
 * considers acceptable, not a change to one resource, and a member who can
 * read the screen deliberately cannot relax the target that judges it.
 */
import { Hono } from "hono";
import { listBackupCoverage } from "@infrawrench/server-core/backups/feed";
import {
  RestoreDrillInputError,
  createRestoreDrill,
  deleteRestoreDrill,
  listDrillCoverage,
  listRestoreDrills,
} from "@infrawrench/server-core/backups/drills";
import { DRILL_OUTCOMES, type DrillOutcome } from "@infrawrench/client-core";
import {
  BackupPolicyInputError,
  createBackupPolicy,
  deleteBackupPolicy,
  listBackupPolicies,
  updateBackupPolicy,
} from "@infrawrench/server-core/backups/store";
import type { BackupPolicyInput } from "@infrawrench/client-core";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * Parse a JSON object body. Discriminated on `ok` rather than on the presence
 * of an `error` key, because `{"error": "..."}` is a perfectly legal request
 * body and the sloppier shape would misread it as a parse failure.
 */
async function readObjectBody(req: {
  json: () => Promise<unknown>;
}): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const parsed = await req.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: "Request body must be an object" };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }
}

/**
 * Read one optional nullable integer out of a body, distinguishing "absent"
 * (leave alone) from `null` (clear) — which is the whole point of a PATCH here,
 * since clearing an RPO is a legitimate edit.
 */
function readNullableInt(
  body: Record<string, unknown>,
  key: string,
): { ok: true; value: number | null | undefined } | { ok: false; error: string } {
  if (!(key in body)) return { ok: true, value: undefined };
  const raw = body[key];
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return { ok: false, error: `${key} must be a whole number or null` };
  }
  return { ok: true, value: raw };
}

function readNullableString(
  body: Record<string, unknown>,
  key: string,
): { ok: true; value: string | null | undefined } | { ok: false; error: string } {
  if (!(key in body)) return { ok: true, value: undefined };
  const raw = body[key];
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: `${key} must be a string or null` };
  return { ok: true, value: raw };
}

function readTypeIds(
  body: Record<string, unknown>,
): { ok: true; value: string[] | undefined } | { ok: false; error: string } {
  if (!("resourceTypeIds" in body)) return { ok: true, value: undefined };
  const raw = body["resourceTypeIds"];
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
    return { ok: false, error: "resourceTypeIds must be an array of strings" };
  }
  return { ok: true, value: raw as string[] };
}

/**
 * GET /api/org/:orgId/backups — what protects the org's stateful resources,
 * what does not, and which backups protect nothing.
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await listBackupCoverage(c.get("organizationId")));
});

/** GET /api/org/:orgId/backups/policies — the org's recovery objectives. */
app.get("/policies", async (c) => {
  requirePermission(c, "resources:read");
  return c.json({ policies: await listBackupPolicies(c.get("organizationId")) });
});

/** POST /api/org/:orgId/backups/policies — add a recovery objective. */
app.post("/policies", async (c) => {
  requirePermission(c, "org:settings:write");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const body = parsed.body;
  const name = body["name"];
  if (typeof name !== "string") return c.json({ error: "name is required" }, 400);

  const typeIds = readTypeIds(body);
  if (!typeIds.ok) return c.json({ error: typeIds.error }, 400);
  const tagKey = readNullableString(body, "tagKey");
  if (!tagKey.ok) return c.json({ error: tagKey.error }, 400);
  const tagValue = readNullableString(body, "tagValue");
  if (!tagValue.ok) return c.json({ error: tagValue.error }, 400);
  const maxRpoHours = readNullableInt(body, "maxRpoHours");
  if (!maxRpoHours.ok) return c.json({ error: maxRpoHours.error }, 400);
  const minRetentionDays = readNullableInt(body, "minRetentionDays");
  if (!minRetentionDays.ok) return c.json({ error: minRetentionDays.error }, 400);
  const enabled = body["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }

  const input: BackupPolicyInput = {
    name,
    ...(typeIds.value !== undefined ? { resourceTypeIds: typeIds.value } : {}),
    ...(tagKey.value !== undefined ? { tagKey: tagKey.value } : {}),
    ...(tagValue.value !== undefined ? { tagValue: tagValue.value } : {}),
    ...(maxRpoHours.value !== undefined ? { maxRpoHours: maxRpoHours.value } : {}),
    ...(minRetentionDays.value !== undefined ? { minRetentionDays: minRetentionDays.value } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  };

  const organizationId = c.get("organizationId");
  const userId = c.get("session").userId;
  try {
    const policy = await createBackupPolicy(organizationId, input, userId ?? null);
    void logAudit({
      organizationId,
      userId,
      action: "backup_policy.create",
      entityType: "backup_policy",
      entityId: policy.id,
      metadata: {
        name: policy.name,
        maxRpoHours: policy.maxRpoHours,
        minRetentionDays: policy.minRetentionDays,
      },
    });
    return c.json(policy);
  } catch (err) {
    if (err instanceof BackupPolicyInputError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

/** PATCH /api/org/:orgId/backups/policies/:policyId — edit one. */
app.patch("/policies/:policyId", async (c) => {
  requirePermission(c, "org:settings:write");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const body = parsed.body;
  const name = body["name"];
  if (name !== undefined && typeof name !== "string") {
    return c.json({ error: "name must be a string" }, 400);
  }
  const typeIds = readTypeIds(body);
  if (!typeIds.ok) return c.json({ error: typeIds.error }, 400);
  const tagKey = readNullableString(body, "tagKey");
  if (!tagKey.ok) return c.json({ error: tagKey.error }, 400);
  const tagValue = readNullableString(body, "tagValue");
  if (!tagValue.ok) return c.json({ error: tagValue.error }, 400);
  const maxRpoHours = readNullableInt(body, "maxRpoHours");
  if (!maxRpoHours.ok) return c.json({ error: maxRpoHours.error }, 400);
  const minRetentionDays = readNullableInt(body, "minRetentionDays");
  if (!minRetentionDays.ok) return c.json({ error: minRetentionDays.error }, 400);
  const enabled = body["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }

  const patch: Partial<BackupPolicyInput> = {
    ...(name !== undefined ? { name } : {}),
    ...(typeIds.value !== undefined ? { resourceTypeIds: typeIds.value } : {}),
    ...(tagKey.value !== undefined ? { tagKey: tagKey.value } : {}),
    ...(tagValue.value !== undefined ? { tagValue: tagValue.value } : {}),
    ...(maxRpoHours.value !== undefined ? { maxRpoHours: maxRpoHours.value } : {}),
    ...(minRetentionDays.value !== undefined ? { minRetentionDays: minRetentionDays.value } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  };
  if (Object.keys(patch).length === 0) return c.json({ error: "No changes supplied" }, 400);

  const organizationId = c.get("organizationId");
  try {
    const policy = await updateBackupPolicy(organizationId, c.req.param("policyId"), patch);
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "backup_policy.update",
      entityType: "backup_policy",
      entityId: policy.id,
      metadata: {
        name: policy.name,
        maxRpoHours: policy.maxRpoHours,
        minRetentionDays: policy.minRetentionDays,
        enabled: policy.enabled,
      },
    });
    return c.json(policy);
  } catch (err) {
    if (err instanceof BackupPolicyInputError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

/** DELETE /api/org/:orgId/backups/policies/:policyId */
app.delete("/policies/:policyId", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const policyId = c.req.param("policyId");
  const removed = await deleteBackupPolicy(organizationId, policyId);
  if (!removed) return c.json({ error: "No such backup policy" }, 404);
  void logAudit({
    organizationId,
    userId: c.get("session").userId,
    action: "backup_policy.delete",
    entityType: "backup_policy",
    entityId: policyId,
  });
  return c.body(null, 204);
});

/**
 * GET /api/org/:orgId/backups/drills — where every protected resource stands on
 * restore, plus the org's drill log.
 *
 * `resources:read`, like the coverage it extends.
 */
app.get("/drills", async (c) => {
  requirePermission(c, "resources:read");
  const raw = c.req.query("validDays");
  const validDays = raw === undefined ? undefined : Number(raw);
  if (
    validDays !== undefined &&
    (!Number.isInteger(validDays) || validDays < 7 || validDays > 730)
  ) {
    return c.json({ error: "validDays must be a whole number between 7 and 730" }, 400);
  }
  return c.json(
    await listDrillCoverage(c.get("organizationId"), validDays === undefined ? {} : { validDays }),
  );
});

/** GET /api/org/:orgId/backups/drills/log — the raw drill log. */
app.get("/drills/log", async (c) => {
  requirePermission(c, "resources:read");
  const resourceId = c.req.query("resourceId");
  return c.json({
    drills: await listRestoreDrills(c.get("organizationId"), {
      ...(resourceId ? { resourceId } : {}),
    }),
  });
});

/**
 * POST /api/org/:orgId/backups/drills — record that somebody tried.
 *
 * Takes `resources:write` rather than `org:settings:write`: recording a drill
 * is reporting what you did, not changing what the organization demands, and
 * the person who spent Saturday restoring a database is rarely the person who
 * set the recovery objective.
 */
app.post("/drills", async (c) => {
  requirePermission(c, "resources:write");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const body = parsed.body;

  const resourceId = body["resourceId"];
  const performedAt = body["performedAt"];
  const outcome = body["outcome"];
  if (typeof resourceId !== "string") return c.json({ error: "resourceId is required" }, 400);
  if (typeof performedAt !== "string") return c.json({ error: "performedAt is required" }, 400);
  if (typeof outcome !== "string" || !DRILL_OUTCOMES.includes(outcome as DrillOutcome)) {
    return c.json({ error: `outcome must be one of ${DRILL_OUTCOMES.join(", ")}` }, 400);
  }
  const rto = readNullableInt(body, "rtoMinutes");
  if (!rto.ok) return c.json({ error: rto.error }, 400);
  const restoredFrom = readNullableString(body, "restoredFrom");
  if (!restoredFrom.ok) return c.json({ error: restoredFrom.error }, 400);
  const notes = readNullableString(body, "notes");
  if (!notes.ok) return c.json({ error: notes.error }, 400);

  const organizationId = c.get("organizationId");
  try {
    const drill = await createRestoreDrill(
      organizationId,
      {
        resourceId,
        performedAt,
        outcome: outcome as DrillOutcome,
        ...(rto.value !== undefined ? { rtoMinutes: rto.value } : {}),
        ...(restoredFrom.value !== undefined ? { restoredFrom: restoredFrom.value } : {}),
        ...(notes.value !== undefined ? { notes: notes.value } : {}),
      },
      c.get("session").userId ?? null,
    );
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "restore_drill.record",
      entityType: "restore_drill",
      entityId: drill.id,
      metadata: {
        resourceId: drill.resourceId,
        outcome: drill.outcome,
        rtoMinutes: drill.rtoMinutes,
      },
    });
    return c.json(drill);
  } catch (err) {
    if (err instanceof RestoreDrillInputError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

/**
 * DELETE /api/org/:orgId/backups/drills/:drillId
 *
 * For a drill recorded against the wrong resource or the wrong date. Audited,
 * because deleting evidence that a restore failed is exactly the edit a
 * reviewer would want to know about.
 */
app.delete("/drills/:drillId", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const drillId = c.req.param("drillId");
  const removed = await deleteRestoreDrill(organizationId, drillId);
  if (!removed) return c.json({ error: "No such drill" }, 404);
  void logAudit({
    organizationId,
    userId: c.get("session").userId,
    action: "restore_drill.delete",
    entityType: "restore_drill",
    entityId: drillId,
  });
  return c.body(null, 204);
});

export { app as backupRoutes };
