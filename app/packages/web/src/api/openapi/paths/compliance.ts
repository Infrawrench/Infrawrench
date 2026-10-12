import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const IsoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ format: "date", example: "2026-09-30" });

const FrameworkId = z.string().openapi({
  description: "Framework registry id: `soc2` or `iso27001`.",
  example: "soc2",
});

const EvidenceStatus = z.enum(["present", "gap", "no-data", "unavailable"]).openapi({
  description:
    "`present`: evidence exists and shows nothing wrong. `gap`: evidence shows a problem. " +
    "`no-data`: the source ran and has nothing to show. `unavailable`: the source could not " +
    "be read (missing permission, read failure, no evaluator); never counted as evidence.",
});

const ControlStatus = z.enum(["evidence", "gaps", "not-applicable"]).openapi({
  description:
    "`evidence`: at least one mapped source has evidence and none shows a gap. `gaps`: a " +
    "source shows a gap, or no mapped source produced evidence. `not-applicable`: the org " +
    "said so, with a justification.",
});

const PeriodQuery = z.object({
  framework: FrameworkId,
  from: IsoDay.optional().describe("First day of the period (UTC). Defaults to 90 days before `to`."),
  to: IsoDay.optional().describe("Last day of the period, inclusive (UTC). Defaults to today."),
});

const PackCadence = z.enum(["monthly", "quarterly"]).openapi({
  description:
    "`monthly` delivers the previous calendar month on `sendDayOfMonth`; `quarterly` " +
    "delivers the previous calendar quarter in January, April, July and October.",
});

export function registerCompliancePaths(ctx: BuildContext) {
  const { registry } = ctx;
  const tags = ["Compliance"];

  const FrameworkSummary = strict({
    id: FrameworkId,
    name: z.string().openapi({ example: "SOC 2" }),
    version: z.string(),
    description: z.string(),
    scopeNote: z.string().describe("Which controls the registry covers and which need outside evidence."),
    controlCount: z.number().int(),
  }).openapi("ComplianceFrameworkSummary");

  const Metric = strict({
    key: z.string(),
    label: z.string(),
    value: z.union([z.number(), z.string()]).nullable().describe("Null when unknown; never read as zero."),
  }).openapi("ComplianceEvidenceMetric");

  const SourceResult = strict({
    sourceId: z.string().openapi({ example: "vulnerabilities" }),
    label: z.string(),
    kind: z.enum(["snapshot", "period"]).describe(
      "`snapshot` sources describe the org at generation time; `period` sources are filtered to the period.",
    ),
    status: EvidenceStatus,
    summary: z.string(),
    metrics: z.array(Metric),
    gaps: z.array(z.string()),
    itemCount: z.number().int().describe("Rows this source contributes to an evidence pack."),
    error: z.string().nullable(),
  }).openapi("ComplianceEvidenceSourceResult");

  const Owner = strict({
    userId: Uuid.nullable(),
    displayName: z.string(),
    isLabel: z.boolean(),
  }).openapi("ComplianceControlOwner");

  const ControlRow = strict({
    id: z.string().openapi({ example: "CC6.1" }),
    title: z.string().describe("Short paraphrase of the control, not the framework's own text."),
    group: z.string(),
    sources: z.array(z.string()),
    status: ControlStatus,
    reasons: z.array(z.string()),
    missingSources: z.array(z.string()),
    applicable: z.boolean(),
    justification: z.string().nullable(),
    owner: Owner.nullable(),
    notes: z.string().nullable(),
    settingUpdatedAt: IsoDateTime.nullable(),
  }).openapi("ComplianceControlRow");

  const Counts = strict({
    evidence: z.number().int(),
    gaps: z.number().int(),
    notApplicable: z.number().int(),
    total: z.number().int(),
    unowned: z.number().int(),
  }).openapi("ComplianceStatusCounts");

  const StatusResponse = strict({
    framework: FrameworkSummary,
    period: strict({ from: IsoDay, to: IsoDay }),
    controls: z.array(ControlRow),
    sources: z.array(SourceResult),
    counts: Counts,
    generatedAt: IsoDateTime,
  }).openapi("ComplianceStatus");

  const ControlSetting = strict({
    frameworkId: FrameworkId,
    controlId: z.string().openapi({ example: "8.8" }),
    applicable: z.boolean(),
    justification: z.string().nullable().describe("Required when `applicable` is false."),
    ownerUserId: z.string().nullable().describe("A member who owns the control."),
    ownerLabel: z.string().nullable().describe("A team or alias, when the owner is not one member."),
    notes: z.string().nullable(),
    updatedByUserId: z.string().nullable(),
    updatedAt: IsoDateTime,
  }).openapi("ComplianceControlSetting");

  const ControlSettingInput = strict({
    applicable: z.boolean(),
    justification: z.string().max(2000).nullable().optional(),
    ownerUserId: z.string().nullable().optional(),
    ownerLabel: z.string().max(200).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  }).openapi("ComplianceControlSettingInput");

  const DeliveryStatus = z.enum(["pending", "succeeded", "partial", "failed", "no_targets"]);

  const PackSchedule = strict({
    id: Uuid,
    frameworkId: FrameworkId,
    cadence: PackCadence,
    sendDayOfMonth: z.number().int().min(1).max(31),
    hour: z.number().int().min(0).max(23),
    timezone: z.string().openapi({ example: "Europe/London" }),
    slackChannelIds: z.array(z.string()),
    teamsWebhookIds: z.array(z.string()),
    emailRecipients: z.array(z.string()),
    enabled: z.boolean(),
    nextSendAt: IsoDateTime.nullable(),
    lastSentAt: IsoDateTime.nullable(),
    lastStatus: DeliveryStatus.nullable(),
    lastError: z.string().nullable(),
    createdByUserId: z.string().nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }).openapi("CompliancePackSchedule");

  const PackScheduleInput = strict({
    frameworkId: FrameworkId,
    cadence: PackCadence,
    sendDayOfMonth: z.number().int().min(1).max(31).optional(),
    hour: z.number().int().min(0).max(23),
    timezone: z.string(),
    emailRecipients: z.array(z.string()).max(20),
    slackChannelIds: z.array(z.string()).max(20).optional(),
    teamsWebhookIds: z.array(z.string()).max(20).optional(),
    enabled: z.boolean(),
  }).openapi("CompliancePackScheduleInput");

  const Targets = strict({
    slackChannels: z.array(strict({ id: z.string(), label: z.string() })),
    teamsWebhooks: z.array(strict({ id: z.string(), label: z.string() })),
    emailAvailable: z.boolean(),
  }).openapi("CompliancePackDeliveryTargets");

  const SendResult = strict({
    attempted: z.number().int(),
    succeeded: z.number().int(),
    slack: strict({ attempted: z.number().int(), succeeded: z.number().int() }),
    teams: strict({ attempted: z.number().int(), succeeded: z.number().int() }),
    email: strict({ attempted: z.number().int(), succeeded: z.number().int() }),
    pdfAttached: z.boolean(),
    slackFilesUploaded: z.number().int(),
  }).openapi("CompliancePackSendResult");

  const ControlParams = OrgIdParam.extend({
    frameworkId: FrameworkId,
    controlId: z.string().openapi({ example: "CC6.1" }),
  });
  const ScheduleParams = OrgIdParam.extend({ id: Uuid });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/compliance/frameworks",
    tags,
    summary: "List compliance frameworks",
    description:
      "The framework registry: SOC 2 Trust Services Criteria and ISO/IEC 27001:2022 Annex A, " +
      "each listing only the controls Infrawrench holds evidence for.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Frameworks",
        content: { "application/json": { schema: strict({ frameworks: z.array(FrameworkSummary) }) } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/compliance",
    tags,
    summary: "Compliance status for a framework and period",
    description:
      "Runs every evidence source the framework maps (access review, just-in-time access, the " +
      "audit log, posture, vulnerabilities, backup coverage, restore drills, the change timeline, " +
      "change freezes, session recordings, incidents) and returns a status per control. Makes no " +
      "provider API calls. A source whose own permission the caller lacks comes back " +
      "`unavailable` naming it, rather than failing the request.",
    request: { params: OrgIdParam, query: PeriodQuery },
    responses: {
      200: { description: "Status per control", content: { "application/json": { schema: StatusResponse } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/compliance/pack",
    tags,
    summary: "Download an evidence pack",
    description:
      "A ZIP holding `summary.pdf`, `controls.csv`/`controls.json`, one CSV and JSON per control " +
      "under `controls/`, one CSV and JSON per evidence source under `evidence/`, `manifest.json` " +
      "(every other file with its SHA-256) and `SHA256SUMS` (the manifest's own digest, in " +
      "`sha256sum -c` format). Audited as `compliance.pack_exported`.",
    request: { params: OrgIdParam, query: PeriodQuery },
    responses: {
      200: {
        description: "The evidence pack",
        content: { "application/zip": { schema: z.string().openapi({ format: "binary" }) } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/compliance/controls",
    tags,
    summary: "List stored control decisions",
    description: "Only controls somebody decided about; a missing control is applicable and unowned.",
    request: { params: OrgIdParam, query: z.object({ framework: FrameworkId.optional() }) },
    responses: {
      200: {
        description: "Stored decisions",
        content: { "application/json": { schema: strict({ settings: z.array(ControlSetting) }) } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/compliance/controls/{frameworkId}/{controlId}",
    tags,
    summary: "Get one control decision",
    request: { params: ControlParams },
    responses: {
      200: { description: "The decision", content: { "application/json": { schema: ControlSetting } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/compliance/controls/{frameworkId}/{controlId}",
    tags,
    summary: "Set a control's applicability, owner and notes",
    description:
      "A full replace. Marking a control not applicable requires a justification. An owner is " +
      "either a member (`ownerUserId`) or a free-text label, not both. Audited.",
    request: {
      params: ControlParams,
      body: { content: { "application/json": { schema: ControlSettingInput } } },
    },
    responses: {
      200: { description: "The saved decision", content: { "application/json": { schema: ControlSetting } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/compliance/controls/{frameworkId}/{controlId}",
    tags,
    summary: "Reset a control to applicable and unowned",
    request: { params: ControlParams },
    responses: {
      204: { description: "The decision was removed" },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/compliance/schedules",
    tags,
    summary: "List evidence-pack schedules",
    request: { params: OrgIdParam, query: z.object({ framework: FrameworkId.optional() }) },
    responses: {
      200: { description: "Schedules", content: { "application/json": { schema: z.array(PackSchedule) } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/compliance/schedules/targets",
    tags,
    summary: "Destinations a pack schedule can use",
    request: { params: OrgIdParam },
    responses: {
      200: { description: "Slack channels, Teams webhooks, email", content: { "application/json": { schema: Targets } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/compliance/schedules",
    tags,
    summary: "Schedule an evidence pack",
    description:
      "Delivers the previous calendar month or quarter's pack: email attaches the ZIP, Slack " +
      "uploads it in the message thread, Teams gets the summary and a link. Packs render with " +
      "full access. Audited.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: PackScheduleInput } } },
    },
    responses: {
      201: { description: "The schedule", content: { "application/json": { schema: PackSchedule } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/compliance/schedules/{id}",
    tags,
    summary: "Get an evidence-pack schedule",
    request: { params: ScheduleParams },
    responses: {
      200: { description: "The schedule", content: { "application/json": { schema: PackSchedule } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/compliance/schedules/{id}",
    tags,
    summary: "Replace an evidence-pack schedule",
    request: {
      params: ScheduleParams,
      body: { content: { "application/json": { schema: PackScheduleInput } } },
    },
    responses: {
      200: { description: "The schedule", content: { "application/json": { schema: PackSchedule } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/compliance/schedules/{id}",
    tags,
    summary: "Delete an evidence-pack schedule",
    request: { params: ScheduleParams },
    responses: {
      204: { description: "Deleted" },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/compliance/schedules/{id}/send",
    tags,
    summary: "Send an evidence-pack schedule now",
    description: "Builds the pack the next delivery would cover and sends it immediately.",
    request: { params: ScheduleParams },
    responses: {
      200: { description: "Per-transport outcome", content: { "application/json": { schema: SendResult } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
}
