/**
 * Compliance: `/api/org/:orgId/compliance`, the endpoint definitions.
 * Evidence Infrawrench already collects, mapped to framework controls,
 * per-control decisions, and evidence packs (download and schedule).
 *
 * Reading status, decisions, schedules and downloading a pack is
 * `audit:read`: the people who answer auditors, and a pack carries the audit
 * log. Inside a read, each evidence source checks its own permission and
 * comes back `unavailable` naming it. Control decisions and pack schedules
 * are `org:settings:write`, the dashboard-schedule rule: a schedule is
 * standing authorization to ship the org's evidence to arbitrary addresses.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { maxLength, pattern } from "../schemas";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgId, OrgIdParams, OrgParams, Uuid } from "../http/schemas/common";
import { documentedAs, optionalRequestBody, requiredQuery } from "../http/schemas/documented";

const IsoDay = Schema.String.check(pattern(/^\d{4}-\d{2}-\d{2}$/)).annotate({
  format: "date",
  examples: ["2026-09-30"],
});

const FrameworkId = Schema.String.annotate({
  description: "Framework registry id: `soc2` or `iso27001`.",
  examples: ["soc2"],
});

const EvidenceStatus = Schema.Literals(["present", "gap", "no-data", "unavailable"]).annotate({
  description:
    "`present`: evidence exists and shows nothing wrong. `gap`: evidence shows a problem. " +
    "`no-data`: the source ran and has nothing to show. `unavailable`: the source could not " +
    "be read (missing permission, read failure, no evaluator); never counted as evidence.",
});

const ControlStatus = Schema.Literals(["evidence", "gaps", "not-applicable"]).annotate({
  description:
    "`evidence`: at least one mapped source has evidence and none shows a gap. `gaps`: a " +
    "source shows a gap, or no mapped source produced evidence. `not-applicable`: the org " +
    "said so, with a justification.",
});

/**
 * Read raw: the framework and the period are checked by server-core, whose
 * refusals (unknown framework, bad day) keep their own sentences.
 */
const PeriodQuery = {
  framework: Schema.optionalKey(documentedAs(FrameworkId)),
  from: Schema.optionalKey(
    documentedAs(
      IsoDay.annotate({
        description: "First day of the period (UTC). Defaults to 90 days before `to`.",
      }),
    ),
  ),
  to: Schema.optionalKey(
    documentedAs(
      IsoDay.annotate({
        description: "Last day of the period, inclusive (UTC). Defaults to today.",
      }),
    ),
  ),
};

const PackCadence = Schema.Literals(["monthly", "quarterly"]).annotate({
  description:
    "`monthly` delivers the previous calendar month on `sendDayOfMonth`; `quarterly` " +
    "delivers the previous calendar quarter in January, April, July and October.",
});

const ComplianceFrameworkSummary = Schema.Struct({
  id: FrameworkId,
  name: Schema.String.annotate({ examples: ["SOC 2"] }),
  version: Schema.String,
  description: Schema.String,
  scopeNote: Schema.String.annotate({
    description: "Which controls the registry covers and which need outside evidence.",
  }),
  controlCount: Schema.Int,
}).annotate({ identifier: "ComplianceFrameworkSummary" });

export const ComplianceFrameworks = Schema.Struct({
  frameworks: Schema.Array(ComplianceFrameworkSummary),
});

const ComplianceEvidenceMetric = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  value: Schema.NullOr(Schema.Union([Schema.Finite, Schema.String])).annotate({
    description: "Null when unknown; never read as zero.",
  }),
}).annotate({ identifier: "ComplianceEvidenceMetric" });

const ComplianceEvidenceSourceResult = Schema.Struct({
  sourceId: Schema.String.annotate({ examples: ["vulnerabilities"] }),
  label: Schema.String,
  kind: Schema.Literals(["snapshot", "period"]).annotate({
    description:
      "`snapshot` sources describe the org at generation time; `period` sources are filtered to the period.",
  }),
  status: EvidenceStatus,
  summary: Schema.String,
  metrics: Schema.Array(ComplianceEvidenceMetric),
  gaps: Schema.Array(Schema.String),
  itemCount: Schema.Int.annotate({
    description: "Rows this source contributes to an evidence pack.",
  }),
  error: Schema.NullOr(Schema.String),
}).annotate({ identifier: "ComplianceEvidenceSourceResult" });

const ComplianceControlOwner = Schema.Struct({
  userId: Schema.NullOr(Uuid),
  displayName: Schema.String,
  isLabel: Schema.Boolean,
}).annotate({ identifier: "ComplianceControlOwner" });

const ComplianceControlRow = Schema.Struct({
  id: Schema.String.annotate({ examples: ["CC6.1"] }),
  title: Schema.String.annotate({
    description: "Short paraphrase of the control, not the framework's own text.",
  }),
  group: Schema.String,
  sources: Schema.Array(Schema.String),
  status: ControlStatus,
  reasons: Schema.Array(Schema.String),
  missingSources: Schema.Array(Schema.String),
  applicable: Schema.Boolean,
  justification: Schema.NullOr(Schema.String),
  owner: Schema.NullOr(ComplianceControlOwner),
  notes: Schema.NullOr(Schema.String),
  settingUpdatedAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "ComplianceControlRow" });

const ComplianceStatusCounts = Schema.Struct({
  evidence: Schema.Int,
  gaps: Schema.Int,
  notApplicable: Schema.Int,
  total: Schema.Int,
  unowned: Schema.Int,
}).annotate({ identifier: "ComplianceStatusCounts" });

export const ComplianceStatus = Schema.Struct({
  framework: ComplianceFrameworkSummary,
  period: Schema.Struct({ from: IsoDay, to: IsoDay }),
  controls: Schema.Array(ComplianceControlRow),
  sources: Schema.Array(ComplianceEvidenceSourceResult),
  counts: ComplianceStatusCounts,
  generatedAt: IsoDateTime,
}).annotate({ identifier: "ComplianceStatus" });

export const ComplianceControlSetting = Schema.Struct({
  frameworkId: FrameworkId,
  controlId: Schema.String.annotate({ examples: ["8.8"] }),
  applicable: Schema.Boolean,
  justification: Schema.NullOr(Schema.String).annotate({
    description: "Required when `applicable` is false.",
  }),
  ownerUserId: Schema.NullOr(Schema.String).annotate({
    description: "A member who owns the control.",
  }),
  ownerLabel: Schema.NullOr(Schema.String).annotate({
    description: "A team or alias, when the owner is not one member.",
  }),
  notes: Schema.NullOr(Schema.String),
  updatedByUserId: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
}).annotate({ identifier: "ComplianceControlSetting" });

export const ComplianceControlSettings = Schema.Struct({
  settings: Schema.Array(ComplianceControlSetting),
});

/** Documented; the handler checks each field and server-core the bounds. */
const ComplianceControlSettingInput = Schema.Struct({
  applicable: Schema.Boolean,
  justification: Schema.optionalKey(Schema.NullOr(Schema.String.check(maxLength(2000)))),
  ownerUserId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ownerLabel: Schema.optionalKey(Schema.NullOr(Schema.String.check(maxLength(200)))),
  notes: Schema.optionalKey(Schema.NullOr(Schema.String.check(maxLength(2000)))),
}).annotate({ identifier: "ComplianceControlSettingInput" });

const DeliveryStatus = Schema.Literals(["pending", "succeeded", "partial", "failed", "no_targets"]);

const SendDayOfMonth = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 }));
const Hour = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 }));

export const CompliancePackSchedule = Schema.Struct({
  id: Uuid,
  frameworkId: FrameworkId,
  cadence: PackCadence,
  sendDayOfMonth: SendDayOfMonth,
  hour: Hour,
  timezone: Schema.String.annotate({ examples: ["Europe/London"] }),
  slackChannelIds: Schema.Array(Schema.String),
  teamsWebhookIds: Schema.Array(Schema.String),
  emailRecipients: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  nextSendAt: Schema.NullOr(IsoDateTime),
  lastSentAt: Schema.NullOr(IsoDateTime),
  lastStatus: Schema.NullOr(DeliveryStatus),
  lastError: Schema.NullOr(Schema.String),
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "CompliancePackSchedule" });

const Recipients = Schema.Array(Schema.String).check(Schema.isMaxLength(20));

/** Documented; the handler checks each field and server-core the bounds. */
const CompliancePackScheduleInput = Schema.Struct({
  frameworkId: FrameworkId,
  cadence: PackCadence,
  sendDayOfMonth: Schema.optionalKey(SendDayOfMonth),
  hour: Hour,
  timezone: Schema.String,
  emailRecipients: Recipients,
  slackChannelIds: Schema.optionalKey(Recipients),
  teamsWebhookIds: Schema.optionalKey(Recipients),
  enabled: Schema.Boolean,
}).annotate({ identifier: "CompliancePackScheduleInput" });

const DeliveryTarget = Schema.Struct({ id: Schema.String, label: Schema.String });

export const CompliancePackDeliveryTargets = Schema.Struct({
  slackChannels: Schema.Array(DeliveryTarget),
  teamsWebhooks: Schema.Array(DeliveryTarget),
  emailAvailable: Schema.Boolean,
}).annotate({ identifier: "CompliancePackDeliveryTargets" });

const TransportOutcome = Schema.Struct({ attempted: Schema.Int, succeeded: Schema.Int });

export const CompliancePackSendResult = Schema.Struct({
  attempted: Schema.Int,
  succeeded: Schema.Int,
  slack: TransportOutcome,
  teams: TransportOutcome,
  email: TransportOutcome,
  pdfAttached: Schema.Boolean,
  slackFilesUploaded: Schema.Int,
}).annotate({ identifier: "CompliancePackSendResult" });

const ControlParams = {
  orgId: OrgId,
  frameworkId: FrameworkId,
  controlId: Schema.String.annotate({ examples: ["CC6.1"] }),
};

const FrameworkFilter = { framework: Schema.optionalKey(FrameworkId) };

export class ComplianceGroup extends HttpApiGroup.make("compliance")
  .add(
    HttpApiEndpoint.get("frameworks", "/frameworks", {
      params: OrgParams,
      success: ComplianceFrameworks,
    })
      .annotate(RequiredPermission, "audit:read")
      .annotate(OpenApi.Summary, "List compliance frameworks")
      .annotate(
        OpenApi.Description,
        "The framework registry: SOC 2 Trust Services Criteria and ISO/IEC 27001:2022 Annex A, " +
          "each listing only the controls Infrawrench holds evidence for.",
      )
      .annotate(SuccessDescription, "Frameworks"),
    HttpApiEndpoint.get("status", "/", {
      params: OrgParams,
      query: PeriodQuery,
      success: ComplianceStatus,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "audit:read")
      .annotate(OpenApi.Summary, "Compliance status for a framework and period")
      .annotate(
        OpenApi.Description,
        "Runs every evidence source the framework maps (access review, just-in-time access, the " +
          "audit log, posture, vulnerabilities, backup coverage, restore drills, the change timeline, " +
          "change freezes, session recordings, incidents, service scorecards, leaked credentials) and " +
          "returns a status per control. Makes no provider API calls. A source whose own " +
          "permission the caller lacks comes back `unavailable` naming it, rather than failing " +
          "the request.",
      )
      .annotate(SuccessDescription, "Status per control")
      .annotate(OpenApi.Transform, requiredQuery(["framework"])),
    HttpApiEndpoint.get("pack", "/pack", {
      params: OrgParams,
      query: PeriodQuery,
      success: Schema.Uint8Array.pipe(
        HttpApiSchema.asUint8Array({ contentType: "application/zip" }),
      ),
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "audit:read")
      .annotate(OpenApi.Summary, "Download an evidence pack")
      .annotate(
        OpenApi.Description,
        "A ZIP holding `summary.pdf`, `controls.csv`/`controls.json`, one CSV and JSON per control " +
          "under `controls/`, one CSV and JSON per evidence source under `evidence/`, `manifest.json` " +
          "(every other file with its SHA-256) and `SHA256SUMS` (the manifest's own digest, in " +
          "`sha256sum -c` format). Audited as `compliance.pack_exported`.",
      )
      .annotate(SuccessDescription, "The evidence pack")
      .annotate(OpenApi.Transform, requiredQuery(["framework"])),
    HttpApiEndpoint.get("listControls", "/controls", {
      params: OrgParams,
      query: FrameworkFilter,
      success: ComplianceControlSettings,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "audit:read")
      .annotate(OpenApi.Summary, "List stored control decisions")
      .annotate(
        OpenApi.Description,
        "Only controls somebody decided about; a missing control is applicable and unowned.",
      )
      .annotate(SuccessDescription, "Stored decisions"),
    HttpApiEndpoint.get("getControl", "/controls/:frameworkId/:controlId", {
      params: ControlParams,
      success: ComplianceControlSetting,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "audit:read")
      .annotate(OpenApi.Summary, "Get one control decision")
      .annotate(SuccessDescription, "The decision"),
    HttpApiEndpoint.put("putControl", "/controls/:frameworkId/:controlId", {
      params: ControlParams,
      payload: ComplianceControlSettingInput,
      success: ComplianceControlSetting,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Set a control's applicability, owner and notes")
      .annotate(
        OpenApi.Description,
        "A full replace. Marking a control not applicable requires a justification. An owner is " +
          "either a member (`ownerUserId`) or a free-text label, not both. Audited.",
      )
      .annotate(SuccessDescription, "The saved decision")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("deleteControl", "/controls/:frameworkId/:controlId", {
      params: ControlParams,
      success: HttpApiSchema.NoContent,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Reset a control to applicable and unowned")
      .annotate(SuccessDescription, "The decision was removed"),
    HttpApiEndpoint.get("listSchedules", "/schedules", {
      params: OrgParams,
      query: FrameworkFilter,
      success: Schema.Array(CompliancePackSchedule),
    })
      .annotate(RequiredPermission, "audit:read")
      .annotate(OpenApi.Summary, "List evidence-pack schedules")
      .annotate(SuccessDescription, "Schedules"),
    HttpApiEndpoint.get("scheduleTargets", "/schedules/targets", {
      params: OrgParams,
      success: CompliancePackDeliveryTargets,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Destinations a pack schedule can use")
      .annotate(SuccessDescription, "Slack channels, Teams webhooks, email"),
    HttpApiEndpoint.post("createSchedule", "/schedules", {
      params: OrgParams,
      payload: CompliancePackScheduleInput,
      success: CompliancePackSchedule.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Schedule an evidence pack")
      .annotate(
        OpenApi.Description,
        "Delivers the previous calendar month or quarter's pack: email attaches the ZIP, Slack " +
          "uploads it in the message thread, Teams gets the summary and a link. Packs render with " +
          "full access. Audited.",
      )
      .annotate(SuccessDescription, "The schedule")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.get("getSchedule", "/schedules/:id", {
      params: OrgIdParams,
      success: CompliancePackSchedule,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "audit:read")
      .annotate(OpenApi.Summary, "Get an evidence-pack schedule")
      .annotate(SuccessDescription, "The schedule"),
    HttpApiEndpoint.put("updateSchedule", "/schedules/:id", {
      params: OrgIdParams,
      payload: CompliancePackScheduleInput,
      success: CompliancePackSchedule,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Replace an evidence-pack schedule")
      .annotate(SuccessDescription, "The schedule")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("deleteSchedule", "/schedules/:id", {
      params: OrgIdParams,
      success: HttpApiSchema.NoContent,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Delete an evidence-pack schedule")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.post("sendSchedule", "/schedules/:id/send", {
      params: OrgIdParams,
      success: CompliancePackSendResult,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Send an evidence-pack schedule now")
      .annotate(
        OpenApi.Description,
        "Builds the pack the next delivery would cover and sends it immediately.",
      )
      .annotate(SuccessDescription, "Per-transport outcome"),
  )
  .prefix("/api/org/:orgId/compliance")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Compliance") {}

export class ComplianceApi extends withApiDefaults(
  HttpApi.make("compliance").add(ComplianceGroup),
) {}
