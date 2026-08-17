/**
 * Runbook routes (`/api/org/:orgId/runbooks*`).
 *
 * Two permission levels, and the split is the point. **Reading and performing**
 * a runbook takes `resources:read`: the person who can see the infrastructure
 * is the person who will be woken up about it, and a checklist nobody on call
 * can open is worse than no checklist. **Editing** takes `org:settings:write` —
 * a procedure is an org-wide statement about how something is done, and it is
 * read by strangers under pressure.
 *
 * A `workflow` step does not run the workflow here. It records which workflow
 * run the responder started, and the run itself goes through the existing
 * workflow routes with their own permission, approvals and secrets. Anything
 * else would make this route a second way to execute code with a weaker gate
 * than the first.
 */
import { Hono } from "hono";
import type { RunbookInput, RunbookStepInput, RunbookStepStatus } from "@infrawrench/client-core";
import {
  RunbookInputError,
  createRunbook,
  deleteRunbook,
  getRunbook,
  listRunbooks,
  updateRunbook,
} from "@infrawrench/server-core/runbooks/store";
import {
  closeRunbookRun,
  getRunbookRun,
  listRunbookRuns,
  startRunbookRun,
  updateRunbookRunStep,
} from "@infrawrench/server-core/runbooks/runs";

import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

const STEP_STATUSES: RunbookStepStatus[] = ["pending", "done", "skipped", "failed"];

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

/**
 * Read the steps array.
 *
 * Shape-checked here and *content*-checked by `validateRunbookInput` in the
 * store, so the message a user sees about a missing workflow id comes from the
 * same function the editor previews with.
 */
function readSteps(
  body: Record<string, unknown>,
): { ok: true; value: RunbookStepInput[] | undefined } | { ok: false; error: string } {
  if (!("steps" in body)) return { ok: true, value: undefined };
  const raw = body["steps"];
  if (!Array.isArray(raw)) return { ok: false, error: "steps must be an array" };
  const steps: RunbookStepInput[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: "Each step must be an object" };
    }
    const step = entry as Record<string, unknown>;
    const kind = step["kind"];
    if (kind !== "manual" && kind !== "workflow" && kind !== "link") {
      return { ok: false, error: "Each step's kind must be manual, workflow or link" };
    }
    if (typeof step["title"] !== "string") {
      return { ok: false, error: "Each step needs a title" };
    }
    steps.push({
      ...(typeof step["id"] === "string" ? { id: step["id"] } : {}),
      kind,
      title: step["title"],
      ...(typeof step["body"] === "string" ? { body: step["body"] } : {}),
      ...(typeof step["workflowId"] === "string" ? { workflowId: step["workflowId"] } : {}),
      ...(typeof step["url"] === "string" ? { url: step["url"] } : {}),
    });
  }
  return { ok: true, value: steps };
}

function readRunbookBody(
  body: Record<string, unknown>,
): { ok: true; value: Partial<RunbookInput> } | { ok: false; error: string } {
  const name = body["name"];
  if (name !== undefined && typeof name !== "string") {
    return { ok: false, error: "name must be a string" };
  }
  const description = readNullableString(body, "description");
  if (!description.ok) return { ok: false, error: description.error };
  const tagKey = readNullableString(body, "tagKey");
  if (!tagKey.ok) return { ok: false, error: tagKey.error };
  const tagValue = readNullableString(body, "tagValue");
  if (!tagValue.ok) return { ok: false, error: tagValue.error };
  const steps = readSteps(body);
  if (!steps.ok) return { ok: false, error: steps.error };

  let resourceTypeIds: string[] | undefined;
  if ("resourceTypeIds" in body) {
    const raw = body["resourceTypeIds"];
    if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
      return { ok: false, error: "resourceTypeIds must be an array of strings" };
    }
    resourceTypeIds = raw as string[];
  }
  const enabled = body["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return { ok: false, error: "enabled must be a boolean" };
  }

  return {
    ok: true,
    value: {
      ...(name !== undefined ? { name } : {}),
      ...(description.value !== undefined ? { description: description.value } : {}),
      ...(steps.value !== undefined ? { steps: steps.value } : {}),
      ...(resourceTypeIds !== undefined ? { resourceTypeIds } : {}),
      ...(tagKey.value !== undefined ? { tagKey: tagKey.value } : {}),
      ...(tagValue.value !== undefined ? { tagValue: tagValue.value } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    },
  };
}

/** GET /api/org/:orgId/runbooks — every runbook the org has. */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json({ runbooks: await listRunbooks(c.get("organizationId")) });
});

/** GET /api/org/:orgId/runbooks/runs — recent runs across every runbook. */
app.get("/runs", async (c) => {
  requirePermission(c, "resources:read");
  const runbookId = c.req.query("runbookId");
  const incidentId = c.req.query("incidentId");
  const rawLimit = c.req.query("limit");
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
    return c.json({ error: "limit must be a whole number between 1 and 200" }, 400);
  }
  return c.json({
    runs: await listRunbookRuns(c.get("organizationId"), {
      ...(runbookId ? { runbookId } : {}),
      ...(incidentId ? { incidentId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    }),
  });
});

/** GET /api/org/:orgId/runbooks/runs/:runId */
app.get("/runs/:runId", async (c) => {
  requirePermission(c, "resources:read");
  const run = await getRunbookRun(c.get("organizationId"), c.req.param("runId"));
  if (!run) return c.json({ error: "No such runbook run" }, 404);
  return c.json(run);
});

/**
 * PATCH /api/org/:orgId/runbooks/runs/:runId/steps/:stepId — tick a step.
 *
 * Takes `resources:read`, like starting a run: performing a checklist is not an
 * act of configuration, and requiring an admin to tick a box mid-incident is
 * how a team stops using the checklist.
 */
app.patch("/runs/:runId/steps/:stepId", async (c) => {
  requirePermission(c, "resources:read");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const status = parsed.body["status"];
  if (typeof status !== "string" || !STEP_STATUSES.includes(status as RunbookStepStatus)) {
    return c.json({ error: `status must be one of ${STEP_STATUSES.join(", ")}` }, 400);
  }
  const note = readNullableString(parsed.body, "note");
  if (!note.ok) return c.json({ error: note.error }, 400);
  const workflowRunId = readNullableString(parsed.body, "workflowRunId");
  if (!workflowRunId.ok) return c.json({ error: workflowRunId.error }, 400);

  try {
    return c.json(
      await updateRunbookRunStep({
        organizationId: c.get("organizationId"),
        runId: c.req.param("runId"),
        stepId: c.req.param("stepId"),
        status: status as RunbookStepStatus,
        ...(note.value !== undefined ? { note: note.value } : {}),
        ...(workflowRunId.value !== undefined ? { workflowRunId: workflowRunId.value } : {}),
        userId: c.get("session").userId ?? null,
      }),
    );
  } catch (err) {
    if (err instanceof RunbookInputError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

/** POST /api/org/:orgId/runbooks/runs/:runId/close */
app.post("/runs/:runId/close", async (c) => {
  requirePermission(c, "resources:read");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const status = parsed.body["status"];
  if (status !== "completed" && status !== "abandoned") {
    return c.json({ error: "status must be completed or abandoned" }, 400);
  }
  const summary = readNullableString(parsed.body, "summary");
  if (!summary.ok) return c.json({ error: summary.error }, 400);

  const organizationId = c.get("organizationId");
  try {
    const run = await closeRunbookRun({
      organizationId,
      runId: c.req.param("runId"),
      status,
      ...(summary.value !== undefined ? { summary: summary.value } : {}),
    });
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "runbook_run.close",
      entityType: "runbook_run",
      entityId: run.id,
      metadata: { runbook: run.runbookName, status: run.status },
    });
    return c.json(run);
  } catch (err) {
    if (err instanceof RunbookInputError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

/** GET /api/org/:orgId/runbooks/:runbookId */
app.get("/:runbookId", async (c) => {
  requirePermission(c, "resources:read");
  const runbook = await getRunbook(c.get("organizationId"), c.req.param("runbookId"));
  if (!runbook) return c.json({ error: "No such runbook" }, 404);
  return c.json(runbook);
});

/**
 * POST /api/org/:orgId/runbooks/:runbookId/runs — start performing it.
 *
 * `resources:read`, deliberately: the point of a runbook is that whoever is
 * awake can follow it.
 */
app.post("/:runbookId/runs", async (c) => {
  requirePermission(c, "resources:read");
  const parsed = await readObjectBody(c.req).catch(() => null);
  const incidentId =
    parsed && parsed.ok && typeof parsed.body["incidentId"] === "string"
      ? (parsed.body["incidentId"] as string)
      : null;

  const organizationId = c.get("organizationId");
  try {
    const run = await startRunbookRun({
      organizationId,
      runbookId: c.req.param("runbookId"),
      userId: c.get("session").userId ?? null,
      incidentId,
    });
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "runbook_run.start",
      entityType: "runbook_run",
      entityId: run.id,
      metadata: { runbook: run.runbookName, incidentId: run.incidentId },
    });
    return c.json(run);
  } catch (err) {
    if (err instanceof RunbookInputError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

/** POST /api/org/:orgId/runbooks — write one. */
app.post("/", async (c) => {
  requirePermission(c, "org:settings:write");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const fields = readRunbookBody(parsed.body);
  if (!fields.ok) return c.json({ error: fields.error }, 400);
  if (typeof fields.value.name !== "string") return c.json({ error: "name is required" }, 400);

  const organizationId = c.get("organizationId");
  try {
    const runbook = await createRunbook(
      organizationId,
      fields.value as RunbookInput,
      c.get("session").userId ?? null,
    );
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "runbook.create",
      entityType: "runbook",
      entityId: runbook.id,
      metadata: { name: runbook.name, steps: runbook.steps.length },
    });
    return c.json(runbook);
  } catch (err) {
    if (err instanceof RunbookInputError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

/** PATCH /api/org/:orgId/runbooks/:runbookId */
app.patch("/:runbookId", async (c) => {
  requirePermission(c, "org:settings:write");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const fields = readRunbookBody(parsed.body);
  if (!fields.ok) return c.json({ error: fields.error }, 400);
  if (Object.keys(fields.value).length === 0) {
    return c.json({ error: "No changes supplied" }, 400);
  }

  const organizationId = c.get("organizationId");
  try {
    const runbook = await updateRunbook(organizationId, c.req.param("runbookId"), fields.value);
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "runbook.update",
      entityType: "runbook",
      entityId: runbook.id,
      metadata: { name: runbook.name, steps: runbook.steps.length, enabled: runbook.enabled },
    });
    return c.json(runbook);
  } catch (err) {
    if (err instanceof RunbookInputError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

/**
 * DELETE /api/org/:orgId/runbooks/:runbookId
 *
 * Takes the run history with it, which is why the section offers "disable"
 * first: a retired procedure that keeps its history is almost always what
 * somebody actually wanted.
 */
app.delete("/:runbookId", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const runbookId = c.req.param("runbookId");
  const removed = await deleteRunbook(organizationId, runbookId);
  if (!removed) return c.json({ error: "No such runbook" }, 404);
  void logAudit({
    organizationId,
    userId: c.get("session").userId,
    action: "runbook.delete",
    entityType: "runbook",
    entityId: runbookId,
  });
  return c.body(null, 204);
});

export { app as runbookRoutes };
