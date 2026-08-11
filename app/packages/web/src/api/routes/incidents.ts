import { Hono, type Context } from "hono";
import {
  IncidentInputError,
  parseIncidentSeverity,
  parseIncidentStatus,
  parseIncidentTimestamp,
  deleteIncidentNoteRecord,
  deleteIncidentRecord,
  listIncidentRecords,
} from "@infrawrench/server-core/incidents/store";
import type { IncidentActions, IncidentStatus } from "@infrawrench/client-core";

import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import {
  addNote,
  assembleIncidentTimeline,
  buildPostmortem,
  declareIncident,
  getIncidentRecord,
  listIncidentNoteRecords,
  patchIncident,
  retryIncidentArtifacts,
  type IncidentActor,
} from "../../services/incidents";
import type { AuthSession } from "../auth-middleware";

/**
 * **Incident mode** — declared operational incidents.
 *
 * Not to be confused with `/status-incidents`, which reports a *provider's*
 * outage scraped from their status page. This tree is about incidents the
 * organisation declares itself.
 *
 * Permissions are `incidents:read` / `incidents:write`, and both are held by
 * members. That is deliberate and slightly unusual for a write permission: the
 * people who notice an outage at 03:14 are rarely admins, and a product where
 * declaring needs an admin is a product where nobody declares. The *governance*
 * side effects keep their own gates — opening a change freeze still needs
 * `freezes:write`, and a declaration by someone without it records the freeze
 * as a failed artefact naming the missing permission rather than escalating.
 */

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

interface ParsedBody {
  body: Record<string, unknown>;
  error?: Response;
}

async function parseObjectBody(c: Context): Promise<ParsedBody> {
  try {
    const parsed = (await c.req.json()) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { body: {}, error: c.json({ error: "Request body must be an object" }, 400) };
    }
    return { body: parsed as Record<string, unknown> };
  } catch {
    return { body: {}, error: c.json({ error: "Invalid JSON body" }, 400) };
  }
}

function incidentErrorResponse(c: Context, err: unknown) {
  if (err instanceof IncidentInputError) {
    return c.json({ error: err.message }, err.status);
  }
  console.error("[incidents] unexpected error:", err);
  return c.json({ error: "Incident operation failed" }, 500);
}

function actorFrom(c: Context): IncidentActor {
  const session = c.get("session") as AuthSession | undefined;
  return {
    userId: session?.userId ?? null,
    permissions: (c.get("permissions") ?? []) as readonly string[],
    appUrl: process.env["APP_URL"] ?? null,
  };
}

function stringArray(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new IncidentInputError("Expected an array of ids.");
  return raw.filter((v): v is string => typeof v === "string");
}

function parseActions(raw: unknown): IncidentActions | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new IncidentInputError("`actions` must be an object.");
  }
  const value = raw as Record<string, unknown>;
  const actions: IncidentActions = {};
  if (value["openFreeze"] !== undefined) actions.openFreeze = Boolean(value["openFreeze"]);
  if (value["pinMoment"] !== undefined) actions.pinMoment = Boolean(value["pinMoment"]);
  if (value["postSlack"] !== undefined) actions.postSlack = Boolean(value["postSlack"]);
  if (value["statusPageId"] !== undefined) {
    actions.statusPageId = value["statusPageId"] ? String(value["statusPageId"]) : null;
  }
  const componentIds = stringArray(value["statusPageComponentIds"]);
  if (componentIds) actions.statusPageComponentIds = componentIds;
  return actions;
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

app.get("/", async (c) => {
  requirePermission(c, "incidents:read");
  const orgId = c.req.param("orgId")!;
  const statusParam = c.req.query("status");
  try {
    const status =
      statusParam && statusParam !== "all"
        ? (parseIncidentStatus(statusParam) as IncidentStatus)
        : undefined;
    const incidents = await listIncidentRecords(orgId, { status });
    return c.json({ incidents });
  } catch (err) {
    return incidentErrorResponse(c, err);
  }
});

app.get("/:incidentId", async (c) => {
  requirePermission(c, "incidents:read");
  const orgId = c.req.param("orgId")!;
  const incidentId = c.req.param("incidentId");
  const incident = await getIncidentRecord(orgId, incidentId);
  if (!incident) return c.json({ error: "Incident not found" }, 404);
  const notes = await listIncidentNoteRecords(incidentId);
  return c.json({ incident, notes });
});

app.get("/:incidentId/timeline", async (c) => {
  requirePermission(c, "incidents:read");
  const orgId = c.req.param("orgId")!;
  const incidentId = c.req.param("incidentId");
  const incident = await getIncidentRecord(orgId, incidentId);
  if (!incident) return c.json({ error: "Incident not found" }, 404);
  try {
    return c.json(await assembleIncidentTimeline(orgId, incident, actorFrom(c)));
  } catch (err) {
    return incidentErrorResponse(c, err);
  }
});

app.get("/:incidentId/postmortem", async (c) => {
  requirePermission(c, "incidents:read");
  const orgId = c.req.param("orgId")!;
  const incidentId = c.req.param("incidentId");
  const incident = await getIncidentRecord(orgId, incidentId);
  if (!incident) return c.json({ error: "Incident not found" }, 404);
  try {
    return c.json(await buildPostmortem(orgId, incident, actorFrom(c)));
  } catch (err) {
    return incidentErrorResponse(c, err);
  }
});

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

app.post("/", async (c) => {
  requirePermission(c, "incidents:write");
  const orgId = c.req.param("orgId")!;
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  try {
    const incident = await declareIncident(
      orgId,
      {
        title: String(body["title"] ?? ""),
        severity: parseIncidentSeverity(body["severity"]),
        summary: body["summary"] === undefined ? undefined : (body["summary"] as string | null),
        startedAt: parseIncidentTimestamp(body["startedAt"], "startedAt"),
        affectedResourceIds: stringArray(body["affectedResourceIds"]),
        affectedAccountIds: stringArray(body["affectedAccountIds"]),
        actions: parseActions(body["actions"]),
      },
      actorFrom(c),
    );
    return c.json(incident, 201);
  } catch (err) {
    return incidentErrorResponse(c, err);
  }
});

app.patch("/:incidentId", async (c) => {
  requirePermission(c, "incidents:write");
  const orgId = c.req.param("orgId")!;
  const incidentId = c.req.param("incidentId");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  try {
    const updated = await patchIncident(
      orgId,
      incidentId,
      {
        ...(body["title"] === undefined ? {} : { title: String(body["title"]) }),
        ...(body["severity"] === undefined
          ? {}
          : { severity: parseIncidentSeverity(body["severity"]) }),
        ...(body["status"] === undefined ? {} : { status: parseIncidentStatus(body["status"]) }),
        ...(body["summary"] === undefined ? {} : { summary: body["summary"] as string | null }),
        ...(body["issueUrl"] === undefined ? {} : { issueUrl: body["issueUrl"] as string | null }),
        ...(body["affectedResourceIds"] === undefined
          ? {}
          : { affectedResourceIds: stringArray(body["affectedResourceIds"]) }),
        ...(body["affectedAccountIds"] === undefined
          ? {}
          : { affectedAccountIds: stringArray(body["affectedAccountIds"]) }),
      },
      actorFrom(c),
    );
    if (!updated) return c.json({ error: "Incident not found" }, 404);
    return c.json(updated);
  } catch (err) {
    return incidentErrorResponse(c, err);
  }
});

/**
 * Re-run whichever artefacts failed. Deliberately its own endpoint rather than
 * a flag on PATCH: retrying is an action with side effects in three external
 * systems, and it should not be something an ordinary edit can trigger by
 * accident.
 */
app.post("/:incidentId/retry-artifacts", async (c) => {
  requirePermission(c, "incidents:write");
  const orgId = c.req.param("orgId")!;
  const incidentId = c.req.param("incidentId");
  try {
    const incident = await retryIncidentArtifacts(orgId, incidentId, actorFrom(c));
    if (!incident) return c.json({ error: "Incident not found" }, 404);
    await logAudit({
      organizationId: orgId,
      userId: c.get("session")?.userId,
      action: "incident.retry_artifacts",
      entityType: "incident",
      entityId: incidentId,
    });
    return c.json(incident);
  } catch (err) {
    return incidentErrorResponse(c, err);
  }
});

app.post("/:incidentId/notes", async (c) => {
  requirePermission(c, "incidents:write");
  const orgId = c.req.param("orgId")!;
  const incidentId = c.req.param("incidentId");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  try {
    const note = await addNote(
      orgId,
      incidentId,
      String(body["body"] ?? ""),
      parseIncidentTimestamp(body["occurredAt"], "occurredAt"),
      actorFrom(c),
    );
    if (!note) return c.json({ error: "Incident not found" }, 404);
    return c.json(note, 201);
  } catch (err) {
    return incidentErrorResponse(c, err);
  }
});

app.delete("/:incidentId/notes/:noteId", async (c) => {
  requirePermission(c, "incidents:write");
  const orgId = c.req.param("orgId")!;
  const incidentId = c.req.param("incidentId");
  const incident = await getIncidentRecord(orgId, incidentId);
  if (!incident) return c.json({ error: "Incident not found" }, 404);
  const deleted = await deleteIncidentNoteRecord(incidentId, c.req.param("noteId"));
  if (!deleted) return c.json({ error: "Note not found" }, 404);
  return c.body(null, 204);
});

app.delete("/:incidentId", async (c) => {
  requirePermission(c, "incidents:write");
  const orgId = c.req.param("orgId")!;
  const incidentId = c.req.param("incidentId");
  const deleted = await deleteIncidentRecord(orgId, incidentId);
  if (!deleted) return c.json({ error: "Incident not found" }, 404);
  await logAudit({
    organizationId: orgId,
    userId: c.get("session")?.userId,
    action: "incident.delete",
    entityType: "incident",
    entityId: incidentId,
  });
  return c.body(null, 204);
});

export { app as incidentRoutes };
