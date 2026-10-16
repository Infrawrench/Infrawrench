/**
 * The savings findings workflow (org-scoped):
 *
 * - `/api/org/:orgId/savings/findings`: every finder's findings with their
 *   lifecycle status, detected date and summary tiles; `POST /status` moves
 *   findings between Ready for review, In progress, Completed and Archived.
 * - `/api/org/:orgId/savings-views`: saved views (filter + status tab + sort),
 *   narrowed by per-object sharing (`savings_view`).
 *
 * Reading is `resources:read`, the finders' own permission. Changing a status
 * is `resources:write`, the posture dismissal argument: archiving a finding
 * takes it off everyone's list, a statement about the resource rather than a
 * personal preference. Views follow the same split. Every status change is
 * audited per finding (`savings_finding.status_changed`) and published as a
 * `savings.finding.status_changed` event.
 *
 * The logic lives in `services/savings-findings.ts`, `services/savings-views.ts`
 * and server-core's `savings/findings.ts`; this file is transport only.
 */
import { Hono, type Context } from "hono";
import {
  matchesSavingsFindingFilter,
  matchesSavingsFindingStatus,
  normalizeSavingsFindingStatusInput,
  normalizeSavingsViewInput,
  parseSavingsFindingsQuery,
  sortSavingsFindings,
  type SavingsFindingFilter,
  type SavingsFindingSort,
  type SavingsFindingStatusFilter,
} from "@infrawrench/client-core";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { orgAppUrl } from "@infrawrench/server-core/app-url";
import { strictlyVisibleAccountIds } from "@infrawrench/server-core/cost/visibility-context";
import { setFindingStatus } from "@infrawrench/server-core/savings/findings";

import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import { listSavingsFindings } from "../../services/savings-findings";
import {
  SavingsViewNameConflictError,
  createSavingsView,
  deleteSavingsView,
  findSavingsView,
  getSavingsView,
  listSavingsViews,
  updateSavingsView,
} from "../../services/savings-views";
import type { AuthSession } from "../auth-middleware";
import { readObjectBody } from "../object-body";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

/* ------------------------------------------------------------------ *
 * Findings
 * ------------------------------------------------------------------ */

const findings = new Hono();

/**
 * GET /savings/findings?status&kind&provider&account&region&tag&minSavings
 * &detectedFrom&detectedTo&q&sort&view&refresh
 *
 * `view` applies a saved view (by id or name); explicit params override its
 * status and sort, and replace its filter field by field. With neither, the
 * status is `all` and the sort is savings, largest first. `summary` always
 * covers every finding the caller can see, whatever the filters.
 */
findings.get("/", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  let query: ReturnType<typeof parseSavingsFindingsQuery>;
  try {
    query = parseSavingsFindingsQuery(
      (name) => c.req.query(name),
      (name) => c.req.queries(name) ?? [],
    );
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }

  let status: SavingsFindingStatusFilter = "all";
  let filter: SavingsFindingFilter = {};
  let sort: SavingsFindingSort = { field: "savings", direction: "desc" };
  if (query.viewId) {
    const view = await findSavingsView(organizationId, query.viewId);
    if (!view) return c.json({ error: `No savings view "${query.viewId}"` }, 404);
    status = view.status;
    filter = view.filter;
    sort = view.sort;
  }
  if (query.status) status = query.status;
  if (query.sort) sort = query.sort;
  filter = { ...filter, ...query.filter };

  const response = await listSavingsFindings(organizationId, {
    canReadCosts: hasPermission(c.get("permissions") ?? [], "costs:read"),
    refresh: c.req.query("refresh") === "true",
  });
  return c.json({
    ...response,
    findings: sortSavingsFindings(
      response.findings.filter(
        (f) => matchesSavingsFindingStatus(f, status) && matchesSavingsFindingFilter(f, filter),
      ),
      sort,
    ),
  });
});

/**
 * POST /savings/findings/status `{keys, status, note?}`: move up to 500
 * findings at once. Completed by hand records `resolution: "manual"`. Keys the
 * caller cannot see come back in `missing`; when none matched it is a 404.
 */
findings.post("/status", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  let input: ReturnType<typeof normalizeSavingsFindingStatusInput>;
  try {
    input = normalizeSavingsFindingStatusInput(parsed.body);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }

  const result = await setFindingStatus(
    organizationId,
    { keys: input.keys, status: input.status, note: input.note ?? null },
    { userId: session.userId ?? null },
    strictlyVisibleAccountIds(organizationId),
    { url: orgAppUrl(organizationId, "costs") },
  );
  if (result.updated.length === 0) {
    return c.json({ error: "No such savings finding", missing: result.missing }, 404);
  }
  for (const change of result.updated) {
    const finding = result.findings.get(change.key);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "savings_finding.status_changed",
      entityType: "savings_finding",
      entityId: change.key,
      metadata: {
        from: result.previous.get(change.key) ?? null,
        to: change.status,
        note: change.statusNote,
        title: finding?.title ?? null,
        ...(result.updated.length > 1 ? { bulk: true } : {}),
      },
    });
  }
  return c.json({ updated: result.updated, missing: result.missing });
});

export { findings as savingsFindingRoutes };

/* ------------------------------------------------------------------ *
 * Saved views
 * ------------------------------------------------------------------ */

const views = new Hono();

function viewWriteError(c: Context, e: unknown) {
  if (e instanceof SavingsViewNameConflictError) return c.json({ error: e.message }, 409);
  throw e;
}

async function readViewInput(c: Context) {
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return { error: parsed.error } as const;
  try {
    return { input: normalizeSavingsViewInput(parsed.body) } as const;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) } as const;
  }
}

/** GET /savings-views: the views the caller can see, alphabetically. */
views.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await listSavingsViews(c.get("organizationId")));
});

/** POST /savings-views: create; the creator owns it. */
views.post("/", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const body = await readViewInput(c);
  if ("error" in body) return c.json({ error: body.error }, 400);
  try {
    const created = await createSavingsView(organizationId, body.input, session.userId ?? null);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "savings_view.create",
      entityType: "savings_view",
      entityId: created.id,
      metadata: { name: created.name },
    });
    return c.json(created);
  } catch (e) {
    return viewWriteError(c, e);
  }
});

/** GET /savings-views/:id */
views.get("/:id", async (c) => {
  requirePermission(c, "resources:read");
  const view = await getSavingsView(c.get("organizationId"), c.req.param("id"));
  if (!view) return c.json({ error: "Not found" }, 404);
  return c.json(view);
});

/** PUT /savings-views/:id: full replace; editor on the view. */
views.put("/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const body = await readViewInput(c);
  if ("error" in body) return c.json({ error: body.error }, 400);
  try {
    const updated = await updateSavingsView(organizationId, c.req.param("id"), body.input);
    if (!updated) return c.json({ error: "Not found" }, 404);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "savings_view.update",
      entityType: "savings_view",
      entityId: updated.id,
      metadata: { name: updated.name },
    });
    return c.json(updated);
  } catch (e) {
    return viewWriteError(c, e);
  }
});

/** DELETE /savings-views/:id: soft delete; owner, or editor when nobody owns it. */
views.delete("/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const id = c.req.param("id");
  if (!(await deleteSavingsView(organizationId, id))) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: c.get("session").userId,
    action: "savings_view.delete",
    entityType: "savings_view",
    entityId: id,
    metadata: {},
  });
  return c.json({ ok: true });
});

export { views as savingsViewRoutes };
