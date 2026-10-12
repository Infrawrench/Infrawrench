/**
 * Compliance routes (`/api/org/:orgId/compliance*`): evidence Infrawrench
 * already collects, mapped to framework controls, per-control decisions, and
 * evidence packs (download and schedule).
 *
 * The computation lives in server-core (`compliance/`); the pure status rule
 * and the framework registry in client-core. Nothing here calls a provider.
 *
 * ## Permissions
 *
 * Reading status, settings, schedules and downloading a pack is `audit:read`:
 * the people who answer auditors, and a pack carries the audit log. Inside a
 * read, each evidence source additionally checks its own permission
 * (`resources:read`, `session-recordings:read`, ...) and comes back
 * `unavailable` naming it, rather than failing the screen. Control decisions
 * and pack schedules are `org:settings:write`, the dashboard-schedule rule: a
 * schedule is standing authorization to ship the org's evidence to arbitrary
 * addresses, and it renders with full access. Pack downloads, control
 * changes and schedule changes are audited.
 */
import { Hono, type Context } from "hono";
import {
  COMPLIANCE_FRAMEWORKS,
  parseCompliancePeriod,
  toFrameworkSummary,
  type ComplianceControlSettingInput,
  type CompliancePackScheduleInput,
} from "@infrawrench/client-core";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import {
  ComplianceInputError,
  deleteComplianceControlSetting,
  getComplianceControlSetting,
  listComplianceControlSettings,
  putComplianceControlSetting,
} from "@infrawrench/server-core/compliance/settings";
import { getComplianceStatus, requireFramework } from "@infrawrench/server-core/compliance/status";
import { buildEvidencePack } from "@infrawrench/server-core/compliance/pack";
import {
  createCompliancePackSchedule,
  deleteCompliancePackSchedule,
  getCompliancePackScheduleRow,
  listCompliancePackSchedules,
  sendCompliancePackScheduleNow,
  toCompliancePackScheduleView,
  updateCompliancePackSchedule,
} from "@infrawrench/server-core/compliance/schedules";
import {
  ReportNotificationInputError,
  listReportDeliveryTargets,
} from "@infrawrench/server-core/report-delivery/store";
import { requirePermission } from "../../auth/permissions";
import { attachmentDisposition } from "../../lib/content-disposition";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";
import { readObjectBody } from "../object-body";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

function asError(e: unknown): { message: string; status: 400 | 404 } | null {
  if (e instanceof ComplianceInputError || e instanceof ReportNotificationInputError) {
    return { message: e.message, status: e.status };
  }
  return null;
}

function canRead(c: Context): (permission: string) => boolean {
  const granted = (c.get("permissions") as string[] | undefined) ?? [];
  return (permission) => hasPermission(granted, permission);
}

function readPeriod(c: Context) {
  return parseCompliancePeriod(c.req.query("from"), c.req.query("to"));
}

/** GET /compliance/frameworks: the registry, for pickers. */
app.get("/frameworks", (c) => {
  requirePermission(c, "audit:read");
  return c.json({ frameworks: COMPLIANCE_FRAMEWORKS.map(toFrameworkSummary) });
});

/** GET /compliance?framework=&from=&to=: status per control for a period. */
app.get("/", async (c) => {
  requirePermission(c, "audit:read");
  const period = readPeriod(c);
  if ("error" in period) return c.json({ error: period.error }, 400);
  try {
    return c.json(
      await getComplianceStatus(c.get("organizationId"), c.req.query("framework") ?? "", {
        period,
        canRead: canRead(c),
      }),
    );
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

/** GET /compliance/pack?framework=&from=&to=: the evidence pack as a ZIP. */
app.get("/pack", async (c) => {
  requirePermission(c, "audit:read");
  const period = readPeriod(c);
  if ("error" in period) return c.json({ error: period.error }, 400);
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  try {
    const pack = await buildEvidencePack(organizationId, c.req.query("framework") ?? "", {
      period,
      canRead: canRead(c),
      generatedBy: session.email || "A member",
    });
    // A pack discloses the audit log, who holds access and every open risk:
    // worth its own audit row even though each part is readable on screen.
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "compliance.pack_exported",
      entityType: "organization",
      entityId: organizationId,
      metadata: {
        framework: pack.manifest.framework.id,
        from: period.from,
        to: period.to,
        files: pack.manifest.files.length,
      },
    });
    return new Response(new Uint8Array(pack.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": attachmentDisposition(pack.filename),
        "Content-Length": String(pack.bytes.byteLength),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

/* ------------------------------------------------------------------ *
 * Control decisions
 * ------------------------------------------------------------------ */

/** GET /compliance/controls?framework=: every stored decision. */
app.get("/controls", async (c) => {
  requirePermission(c, "audit:read");
  const framework = c.req.query("framework");
  try {
    if (framework) requireFramework(framework);
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
  return c.json({
    settings: await listComplianceControlSettings(c.get("organizationId"), framework || undefined),
  });
});

/** GET /compliance/controls/:frameworkId/:controlId: 404 when the org never decided anything. */
app.get("/controls/:frameworkId/:controlId", async (c) => {
  requirePermission(c, "audit:read");
  try {
    const setting = await getComplianceControlSetting(
      c.get("organizationId"),
      c.req.param("frameworkId"),
      c.req.param("controlId"),
    );
    if (!setting) return c.json({ error: "No decision is stored for this control" }, 404);
    return c.json(setting);
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

function readNullableString(body: Record<string, unknown>, key: string): string | null | undefined | { error: string } {
  const v = body[key];
  if (v === undefined || v === null || typeof v === "string") return v;
  return { error: `${key} must be a string or null` };
}

/** PUT /compliance/controls/:frameworkId/:controlId: applicability, owner, notes. A full replace. */
app.put("/controls/:frameworkId/:controlId", async (c) => {
  requirePermission(c, "org:settings:write");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const body = parsed.body;
  if (typeof body["applicable"] !== "boolean") {
    return c.json({ error: "applicable must be a boolean" }, 400);
  }
  const input: ComplianceControlSettingInput = { applicable: body["applicable"] };
  for (const key of ["justification", "ownerUserId", "ownerLabel", "notes"] as const) {
    const v = readNullableString(body, key);
    if (v && typeof v === "object") return c.json({ error: v.error }, 400);
    input[key] = v;
  }
  const organizationId = c.get("organizationId");
  const frameworkId = c.req.param("frameworkId");
  const controlId = c.req.param("controlId");
  try {
    const saved = await putComplianceControlSetting(
      organizationId,
      frameworkId,
      controlId,
      input,
      c.get("session").userId ?? null,
    );
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "compliance.control.updated",
      entityType: "compliance_control",
      entityId: `${frameworkId}/${controlId}`,
      metadata: {
        applicable: saved.applicable,
        ownerUserId: saved.ownerUserId,
        ownerLabel: saved.ownerLabel,
      },
    });
    return c.json(saved);
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

/** DELETE /compliance/controls/:frameworkId/:controlId: back to applicable and unowned. */
app.delete("/controls/:frameworkId/:controlId", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const frameworkId = c.req.param("frameworkId");
  const controlId = c.req.param("controlId");
  try {
    const removed = await deleteComplianceControlSetting(organizationId, frameworkId, controlId);
    if (!removed) return c.json({ error: "No decision is stored for this control" }, 404);
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "compliance.control.reset",
      entityType: "compliance_control",
      entityId: `${frameworkId}/${controlId}`,
    });
    return c.body(null, 204);
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

/* ------------------------------------------------------------------ *
 * Pack schedules
 * ------------------------------------------------------------------ */

function readScheduleInput(body: Record<string, unknown>): CompliancePackScheduleInput | { error: string } {
  const strings = (key: string): string[] | { error: string } | undefined => {
    const v = body[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return { error: `${key} must be an array of strings` };
    return v as string[];
  };
  if (typeof body["frameworkId"] !== "string") return { error: "frameworkId is required" };
  if (body["cadence"] !== "monthly" && body["cadence"] !== "quarterly") {
    return { error: 'cadence must be "monthly" or "quarterly"' };
  }
  if (typeof body["hour"] !== "number") return { error: "hour must be a number" };
  if (typeof body["timezone"] !== "string") return { error: "timezone is required" };
  if (typeof body["enabled"] !== "boolean") return { error: "enabled must be a boolean" };
  if (body["sendDayOfMonth"] !== undefined && typeof body["sendDayOfMonth"] !== "number") {
    return { error: "sendDayOfMonth must be a number" };
  }
  const emails = strings("emailRecipients");
  const slack = strings("slackChannelIds");
  const teams = strings("teamsWebhookIds");
  for (const v of [emails, slack, teams]) if (v && !Array.isArray(v)) return v;
  return {
    frameworkId: body["frameworkId"],
    cadence: body["cadence"],
    sendDayOfMonth: body["sendDayOfMonth"] as number | undefined,
    hour: body["hour"],
    timezone: body["timezone"],
    enabled: body["enabled"],
    emailRecipients: (emails as string[] | undefined) ?? [],
    slackChannelIds: (slack as string[] | undefined) ?? [],
    teamsWebhookIds: (teams as string[] | undefined) ?? [],
  };
}

app.get("/schedules", async (c) => {
  requirePermission(c, "audit:read");
  return c.json(
    await listCompliancePackSchedules(c.get("organizationId"), c.req.query("framework") || undefined),
  );
});

app.get("/schedules/targets", async (c) => {
  requirePermission(c, "org:settings:write");
  return c.json(await listReportDeliveryTargets(c.get("organizationId")));
});

app.get("/schedules/:id", async (c) => {
  requirePermission(c, "audit:read");
  try {
    return c.json(
      toCompliancePackScheduleView(
        await getCompliancePackScheduleRow(c.get("organizationId"), c.req.param("id")),
      ),
    );
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

app.post("/schedules", async (c) => {
  requirePermission(c, "org:settings:write");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const input = readScheduleInput(parsed.body);
  if ("error" in input) return c.json({ error: input.error }, 400);
  const organizationId = c.get("organizationId");
  try {
    const created = await createCompliancePackSchedule(organizationId, input, c.get("session").userId ?? null);
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "compliance.schedule.create",
      entityType: "compliance_pack_schedule",
      entityId: created.id,
      metadata: { frameworkId: created.frameworkId, cadence: created.cadence, recipients: created.emailRecipients.length },
    });
    return c.json(created, 201);
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

app.put("/schedules/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const input = readScheduleInput(parsed.body);
  if ("error" in input) return c.json({ error: input.error }, 400);
  const organizationId = c.get("organizationId");
  try {
    const updated = await updateCompliancePackSchedule(organizationId, c.req.param("id"), input);
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "compliance.schedule.update",
      entityType: "compliance_pack_schedule",
      entityId: updated.id,
      metadata: { frameworkId: updated.frameworkId, cadence: updated.cadence, enabled: updated.enabled },
    });
    return c.json(updated);
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

app.delete("/schedules/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  try {
    await deleteCompliancePackSchedule(organizationId, c.req.param("id"));
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "compliance.schedule.delete",
      entityType: "compliance_pack_schedule",
      entityId: c.req.param("id"),
    });
    return c.body(null, 204);
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

/** POST /compliance/schedules/:id/send: build the next delivery's pack now and send it. */
app.post("/schedules/:id/send", async (c) => {
  requirePermission(c, "org:settings:write");
  try {
    return c.json(await sendCompliancePackScheduleNow(c.get("organizationId"), c.req.param("id")));
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

export { app as complianceRoutes };
