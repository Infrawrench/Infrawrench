import { Hono, type Context } from "hono";
import { z } from "zod";
import { IAC_LIMITS, IAC_STATE_LIMITS } from "@infrawrench/client-core";
import {
  IacInputError,
  deleteIacState,
  listIacStates,
  saveIacState,
} from "@infrawrench/server-core/iac/store";
import {
  buildIacImportPlan,
  getIacResourceStatus,
  runIacReconciliation,
} from "@infrawrench/server-core/iac/service";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

/**
 * **IaC reconciliation** — the ClickOps detector.
 *
 * An org uploads the Terraform state it already has; every synced resource is
 * classified managed / drifted / unmanaged, and the unmanaged ones can be
 * turned into `import` blocks. Distinct from the three other Terraform
 * features (eject-to-Terraform, org config as code, and the Infrawrench
 * Terraform provider) — see `KNOWLEDGE.md`.
 *
 * The uploaded document is parsed and thrown away: only the redacted,
 * truncated attribute projection is stored. Reading is `iac:read` (members
 * have it, for the same reason they can read the change timeline); uploading
 * and deleting are `iac:write`.
 */

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

const uploadSchema = z.object({
  label: z.string().min(1).max(IAC_LIMITS.maxLabelChars),
  accountId: z.string().nullable().optional(),
  document: z.string().min(1),
});

const importPlanSchema = z.object({
  resourceIds: z.array(z.string().min(1)).min(1).max(IAC_LIMITS.maxImportPlanResources),
});

function iacErrorResponse(c: Context, err: unknown) {
  if (err instanceof IacInputError) return c.json({ error: err.message }, err.status);
  console.error("[iac] unexpected error:", err);
  return c.json({ error: "IaC reconciliation failed" }, 500);
}

/** GET /states — every stored state document, newest first. */
app.get("/states", async (c) => {
  requirePermission(c, "iac:read");
  return c.json({ states: await listIacStates(c.get("organizationId")) });
});

/** POST /states — upload and parse one state document. */
app.post("/states", async (c) => {
  requirePermission(c, "iac:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = uploadSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  }
  // Checked here as well as in the parser so an oversized document is refused
  // before anything tries to walk it.
  if (parsed.data.document.length > IAC_STATE_LIMITS.maxDocumentBytes) {
    return c.json(
      {
        error: `State document is larger than the ${IAC_STATE_LIMITS.maxDocumentBytes / (1024 * 1024)} MiB limit.`,
      },
      400,
    );
  }

  try {
    const { state, parsed: document } = await saveIacState({
      organizationId,
      label: parsed.data.label,
      accountId: parsed.data.accountId ?? null,
      document: parsed.data.document,
      userId: session?.userId,
    });
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "iac_state.upload",
      entityType: "iac_state",
      entityId: state.id,
      // Deliberately no attribute values: the audit log must not become the
      // place a redacted secret reappears.
      metadata: {
        label: state.label,
        format: document.format,
        resourceCount: state.resourceCount,
        redactedAttributeCount: state.redactedAttributeCount,
      },
    });
    return c.json({ state }, 201);
  } catch (err) {
    return iacErrorResponse(c, err);
  }
});

/** DELETE /states/:stateId */
app.delete("/states/:stateId", async (c) => {
  requirePermission(c, "iac:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const stateId = c.req.param("stateId");
  try {
    const removed = await deleteIacState(organizationId, stateId);
    if (!removed) return c.json({ error: "Unknown state document" }, 404);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "iac_state.delete",
      entityType: "iac_state",
      entityId: stateId,
    });
    return c.body(null, 204);
  } catch (err) {
    return iacErrorResponse(c, err);
  }
});

/** GET /reconciliation?stateId= — the classification. */
app.get("/reconciliation", async (c) => {
  requirePermission(c, "iac:read");
  const stateId = c.req.query("stateId");
  if (!stateId) return c.json({ error: "Missing stateId" }, 400);
  try {
    return c.json(await runIacReconciliation({ organizationId: c.get("organizationId"), stateId }));
  } catch (err) {
    return iacErrorResponse(c, err);
  }
});

/** POST /import-plan — `import` blocks + resource stanzas for chosen resources. */
app.post("/import-plan", async (c) => {
  requirePermission(c, "iac:read");
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = importPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  }
  try {
    return c.json(await buildIacImportPlan(c.get("organizationId"), parsed.data.resourceIds));
  } catch (err) {
    return iacErrorResponse(c, err);
  }
});

/**
 * GET /resource?resourceId= — the badge on a resource detail page. A query
 * param rather than a path segment because composite resource ids contain
 * slashes (same reason as the change feed's `/changes/resource`).
 */
app.get("/resource", async (c) => {
  requirePermission(c, "iac:read");
  const resourceId = c.req.query("resourceId");
  if (!resourceId) return c.json({ error: "Missing resourceId" }, 400);
  try {
    return c.json(await getIacResourceStatus(c.get("organizationId"), resourceId));
  } catch (err) {
    return iacErrorResponse(c, err);
  }
});

export { app as iacRoutes };
