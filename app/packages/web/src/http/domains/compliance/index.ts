/**
 * Compliance: `/api/org/:orgId/compliance`, the handlers.
 *
 * The computation lives in server-core (`compliance/`); the pure status rule
 * and the framework registry in client-core. Nothing here calls a provider.
 * Each evidence source checks the caller's own permission for it (`canRead`)
 * and reports `unavailable` rather than failing the screen. Pack downloads,
 * control changes and schedule changes are audited.
 */
import { Effect, Predicate, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
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
import {
  BadRequest,
  badRequest,
  ComplianceApi,
  ComplianceControlSetting,
  ComplianceControlSettings,
  ComplianceFrameworks,
  CompliancePackDeliveryTargets,
  CompliancePackSchedule,
  CompliancePackSendResult,
  ComplianceStatus,
  NotFound,
  notFound,
} from "@infrawrench/api-contract";
import { attachmentDisposition } from "../../../lib/content-disposition";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { readObjectBody } from "../../request-body";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

type Body = { readonly [key: string]: unknown };

/** A compliance or delivery-target refusal, with the status it carries. */
const complianceRefusal = (error: unknown): BadRequest | NotFound | undefined => {
  if (error instanceof ComplianceInputError || error instanceof ReportNotificationInputError) {
    return error.status === 404
      ? new NotFound({ error: error.message })
      : new BadRequest({ error: error.message });
  }
  return undefined;
};

const complianceCall = <A>(fn: () => PromiseLike<A>) => legacyTry(fn, complianceRefusal);

/** The caller's own permissions, for each evidence source to check. */
const canRead = Effect.gen(function* () {
  const { permissions } = yield* OrgPrincipal;
  return (permission: string) => hasPermission(permissions, permission);
});

const readPeriod = (query: { readonly from?: string; readonly to?: string }) => {
  const period = parseCompliancePeriod(query.from, query.to);
  return "error" in period ? Effect.fail(badRequest(period.error)) : Effect.succeed(period);
};

function readNullableString(
  body: Body,
  key: string,
): string | null | undefined | { error: string } {
  const v = body[key];
  if (v === undefined || v === null || Predicate.isString(v)) return v;
  return { error: `${key} must be a string or null` };
}

function readStrings(body: Body, key: string): string[] | undefined | { error: string } {
  const v: unknown = body[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return { error: `${key} must be an array of strings` };
  const values: unknown[] = v;
  if (!values.every(Predicate.isString)) return { error: `${key} must be an array of strings` };
  return values;
}

function readScheduleInput(body: Body): CompliancePackScheduleInput | { error: string } {
  const frameworkId = body["frameworkId"];
  const cadence = body["cadence"];
  const hour = body["hour"];
  const timezone = body["timezone"];
  const enabled = body["enabled"];
  const sendDayOfMonth = body["sendDayOfMonth"];
  if (!Predicate.isString(frameworkId)) return { error: "frameworkId is required" };
  if (cadence !== "monthly" && cadence !== "quarterly") {
    return { error: 'cadence must be "monthly" or "quarterly"' };
  }
  if (!Predicate.isNumber(hour)) return { error: "hour must be a number" };
  if (!Predicate.isString(timezone)) return { error: "timezone is required" };
  if (!Predicate.isBoolean(enabled)) return { error: "enabled must be a boolean" };
  if (sendDayOfMonth !== undefined && !Predicate.isNumber(sendDayOfMonth)) {
    return { error: "sendDayOfMonth must be a number" };
  }
  const emails = readStrings(body, "emailRecipients");
  const slack = readStrings(body, "slackChannelIds");
  const teams = readStrings(body, "teamsWebhookIds");
  for (const v of [emails, slack, teams]) if (v && !Array.isArray(v)) return v;
  return {
    frameworkId,
    cadence,
    sendDayOfMonth,
    hour,
    timezone,
    enabled,
    emailRecipients: Array.isArray(emails) ? emails : [],
    slackChannelIds: Array.isArray(slack) ? slack : [],
    teamsWebhookIds: Array.isArray(teams) ? teams : [],
  };
}

const readSchedule = (request: Parameters<typeof readObjectBody>[0]) =>
  Effect.gen(function* () {
    const read = yield* readObjectBody(request);
    if (!read.ok) return yield* badRequest(read.error);
    const input = readScheduleInput(read.body);
    if ("error" in input) return yield* badRequest(input.error);
    return input;
  });

const ComplianceHandlers = HttpApiBuilder.group(ComplianceApi, "compliance", (handlers) =>
  handlers
    /** The registry, for pickers. */
    .handle("frameworks", () =>
      respond(ComplianceFrameworks)({ frameworks: COMPLIANCE_FRAMEWORKS.map(toFrameworkSummary) }),
    )
    /** Status per control for a period. */
    .handle("status", ({ query }) =>
      Effect.gen(function* () {
        const period = yield* readPeriod(query);
        const { organizationId } = yield* OrgPrincipal;
        const check = yield* canRead;
        const status = yield* complianceCall(() =>
          getComplianceStatus(organizationId, query.framework ?? "", { period, canRead: check }),
        );
        return yield* respond(ComplianceStatus)(status);
      }),
    )
    /** The evidence pack as a ZIP. */
    .handle("pack", ({ query }) =>
      Effect.gen(function* () {
        const period = yield* readPeriod(query);
        const { organizationId, session } = yield* OrgPrincipal;
        const check = yield* canRead;
        const pack = yield* complianceCall(() =>
          buildEvidencePack(organizationId, query.framework ?? "", {
            period,
            canRead: check,
            generatedBy: session.email || "A member",
          }),
        );
        // A pack discloses the audit log, who holds access and every open risk:
        // worth its own audit row even though each part is readable on screen.
        yield* fireAndForget(() =>
          logAudit({
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
          }),
        );
        const bytes = new Uint8Array(pack.bytes);
        return HttpServerResponse.uint8Array(bytes, {
          contentType: "application/zip",
          headers: {
            "content-disposition": attachmentDisposition(pack.filename),
            "content-length": String(bytes.byteLength),
            "cache-control": "private, no-store",
          },
        });
      }),
    )
    /** Every stored decision, optionally for one framework. */
    .handle("listControls", ({ query }) =>
      Effect.gen(function* () {
        const framework = query.framework;
        if (framework) {
          yield* complianceCall(async () => {
            requireFramework(framework);
          });
        }
        const { organizationId } = yield* OrgPrincipal;
        const settings = yield* legacy(() =>
          listComplianceControlSettings(organizationId, framework || undefined),
        );
        return yield* respond(ComplianceControlSettings)({ settings });
      }),
    )
    /** 404 when the org never decided anything about the control. */
    .handle("getControl", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const setting = yield* complianceCall(() =>
          getComplianceControlSetting(organizationId, params.frameworkId, params.controlId),
        );
        if (!setting) return yield* notFound("No decision is stored for this control");
        return yield* respond(ComplianceControlSetting)(setting);
      }),
    )
    /** Applicability, owner, notes. A full replace. */
    .handleRaw("putControl", ({ params, request }) =>
      Effect.gen(function* () {
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* badRequest(read.error);
        const body = read.body;
        const applicable = body["applicable"];
        if (!Predicate.isBoolean(applicable)) {
          return yield* badRequest("applicable must be a boolean");
        }
        const input: ComplianceControlSettingInput = { applicable };
        for (const key of ["justification", "ownerUserId", "ownerLabel", "notes"] as const) {
          const v = readNullableString(body, key);
          if (Predicate.isObject(v)) return yield* badRequest(v.error);
          input[key] = v;
        }
        const { organizationId, session } = yield* OrgPrincipal;
        const { frameworkId, controlId } = params;
        const saved = yield* complianceCall(() =>
          putComplianceControlSetting(
            organizationId,
            frameworkId,
            controlId,
            input,
            session.userId ?? null,
          ),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "compliance.control.updated",
            entityType: "compliance_control",
            entityId: `${frameworkId}/${controlId}`,
            metadata: {
              applicable: saved.applicable,
              ownerUserId: saved.ownerUserId,
              ownerLabel: saved.ownerLabel,
            },
          }),
        );
        return yield* respond(ComplianceControlSetting)(saved);
      }),
    )
    /** Back to applicable and unowned. */
    .handle("deleteControl", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const { frameworkId, controlId } = params;
        const removed = yield* complianceCall(() =>
          deleteComplianceControlSetting(organizationId, frameworkId, controlId),
        );
        if (!removed) return yield* notFound("No decision is stored for this control");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "compliance.control.reset",
            entityType: "compliance_control",
            entityId: `${frameworkId}/${controlId}`,
          }),
        );
      }),
    )
    .handle("listSchedules", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const schedules = yield* legacy(() =>
          listCompliancePackSchedules(organizationId, query.framework || undefined),
        );
        return yield* respond(Schema.Array(CompliancePackSchedule))(schedules);
      }),
    )
    .handle("scheduleTargets", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const targets = yield* legacy(() => listReportDeliveryTargets(organizationId));
        return yield* respond(CompliancePackDeliveryTargets)(targets);
      }),
    )
    .handle("getSchedule", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const row = yield* complianceCall(() =>
          getCompliancePackScheduleRow(organizationId, params.id),
        );
        return yield* respond(CompliancePackSchedule)(toCompliancePackScheduleView(row));
      }),
    )
    .handleRaw("createSchedule", ({ request }) =>
      Effect.gen(function* () {
        const input = yield* readSchedule(request);
        const { organizationId, session } = yield* OrgPrincipal;
        const created = yield* complianceCall(() =>
          createCompliancePackSchedule(organizationId, input, session.userId ?? null),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "compliance.schedule.create",
            entityType: "compliance_pack_schedule",
            entityId: created.id,
            metadata: {
              frameworkId: created.frameworkId,
              cadence: created.cadence,
              recipients: created.emailRecipients.length,
            },
          }),
        );
        return yield* respond(CompliancePackSchedule, { status: 201 })(created);
      }),
    )
    .handleRaw("updateSchedule", ({ params, request }) =>
      Effect.gen(function* () {
        const input = yield* readSchedule(request);
        const { organizationId, session } = yield* OrgPrincipal;
        const updated = yield* complianceCall(() =>
          updateCompliancePackSchedule(organizationId, params.id, input),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "compliance.schedule.update",
            entityType: "compliance_pack_schedule",
            entityId: updated.id,
            metadata: {
              frameworkId: updated.frameworkId,
              cadence: updated.cadence,
              enabled: updated.enabled,
            },
          }),
        );
        return yield* respond(CompliancePackSchedule)(updated);
      }),
    )
    .handle("deleteSchedule", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        yield* complianceCall(() => deleteCompliancePackSchedule(organizationId, params.id));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "compliance.schedule.delete",
            entityType: "compliance_pack_schedule",
            entityId: params.id,
          }),
        );
      }),
    )
    /** Build the next delivery's pack now and send it. */
    .handle("sendSchedule", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const result = yield* complianceCall(() =>
          sendCompliancePackScheduleNow(organizationId, params.id),
        );
        return yield* respond(CompliancePackSendResult)(result);
      }),
    ),
);

export const complianceDomain = makeDomain("compliance", ComplianceApi, ComplianceHandlers);
