/**
 * Heartbeat monitors: the endpoint definitions.
 *
 * Two groups, kept apart on purpose (the status pages split):
 *
 * - `heartbeats` (`/api/org/:orgId/heartbeats`) is on the org tree and manages
 *   the rows. Permissions ride the probes stance: reads are `resources:read`
 *   (the suggestions are mined from the org's resources), writes
 *   `resources:write`.
 * - `heartbeatPing` (`/api/ping/:token`) has **no** auth middleware: a
 *   scheduled job pings it with nothing but the URL, whose random token is
 *   the only credential. It reaches the ping recorder and nothing else, and
 *   answers in plain text so `curl -fsS` needs no parsing.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { RequiredPermission, Security, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgId, OrgParams, Uuid } from "../http/schemas/common";
import { PluginId } from "../http/schemas/plugin-registry";

const HeartbeatStatus = Schema.Literals(["new", "up", "down"]).annotate({
  description:
    "`new` until the first ping (a heartbeat never alerts before its job has reported once), " +
    "`up` after a success, `down` after a missed deadline or a `/fail` ping.",
});

const HeartbeatScheduleKind = Schema.Literals(["cron", "interval"]).annotate({
  description: "A cron expression read in `timezone`, or a fixed interval in minutes.",
});

const CronExpression = Schema.String.annotate({
  description: "Five-field cron (minute hour day-of-month month day-of-week).",
  examples: ["0 2 * * *"],
});

const Timezone = Schema.String.annotate({
  description: "IANA time zone the cron expression is read in. Defaults to UTC.",
  examples: ["Europe/London"],
});

const IntervalMinutes = Schema.Int.annotate({
  description: "Minutes between expected pings. Clamped server-side to 1-44640 (31 days).",
  examples: [60],
});

const GraceMinutes = Schema.Int.annotate({
  description:
    "How late a ping may be before the heartbeat goes down. Clamped server-side to 1-10080.",
  examples: [10],
});

const HeartbeatName = Schema.String.annotate({
  description: "Up to 120 characters.",
  examples: ["Nightly backup"],
});

export const Heartbeat = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  scheduleKind: HeartbeatScheduleKind,
  cronExpression: Schema.NullOr(Schema.String),
  timezone: Schema.String,
  intervalMinutes: Schema.NullOr(Schema.Int),
  graceMinutes: Schema.Int,
  enabled: Schema.Boolean.annotate({ description: "False while paused." }),
  status: HeartbeatStatus,
  downReason: Schema.NullOr(Schema.Literals(["missed", "failed"])),
  pingUrl: Schema.String.annotate({
    description:
      "The secret URL the job pings; append `/start` before a run and `/fail` on failure. " +
      "Absolute when the server knows its public address, otherwise a path.",
  }),
  lastPingAt: Schema.NullOr(IsoDateTime),
  lastStartAt: Schema.NullOr(IsoDateTime),
  lastFailAt: Schema.NullOr(IsoDateTime),
  lastDurationMs: Schema.NullOr(Schema.Int).annotate({
    description: "The last run's duration, from its `/start` ping to the ping that closed it.",
  }),
  nextExpectedAt: Schema.NullOr(IsoDateTime),
  deadlineAt: Schema.NullOr(IsoDateTime).annotate({
    description: "`nextExpectedAt` plus the grace period; null while new, paused or down.",
  }),
  lastStateChangeAt: Schema.NullOr(IsoDateTime),
  accountId: Schema.NullOr(Uuid),
  resourceId: Schema.NullOr(Schema.String).annotate({
    description: "The scheduled resource this heartbeat watches; advisory, not a foreign key.",
  }),
  pluginId: Schema.NullOr(PluginId),
  resourceTypeId: Schema.NullOr(Schema.String),
  fieldKey: Schema.NullOr(Schema.String).annotate({
    description: "The resource field the schedule was read from.",
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "Heartbeat" });

export const HeartbeatList = Schema.Struct({
  heartbeats: Schema.Array(Heartbeat),
}).annotate({ identifier: "HeartbeatList" });

export const HeartbeatCreate = Schema.Struct({
  name: HeartbeatName,
  scheduleKind: HeartbeatScheduleKind,
  cronExpression: Schema.optionalKey(CronExpression),
  timezone: Schema.optionalKey(Timezone),
  intervalMinutes: Schema.optionalKey(IntervalMinutes),
  graceMinutes: Schema.optionalKey(GraceMinutes),
  enabled: Schema.optionalKey(Schema.Boolean),
  resourceId: Schema.optionalKey(
    Schema.String.annotate({ description: "Link to the scheduled resource being watched." }),
  ),
  fieldKey: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "HeartbeatCreate" });

export const HeartbeatUpdate = Schema.Struct({
  name: Schema.optionalKey(HeartbeatName),
  scheduleKind: Schema.optionalKey(HeartbeatScheduleKind),
  cronExpression: Schema.optionalKey(CronExpression),
  timezone: Schema.optionalKey(Timezone),
  intervalMinutes: Schema.optionalKey(IntervalMinutes),
  graceMinutes: Schema.optionalKey(GraceMinutes),
  enabled: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "False pauses. Resuming returns the heartbeat to `new` until its next ping.",
    }),
  ),
}).annotate({ identifier: "HeartbeatUpdate" });

const HeartbeatSchedule = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("cron"),
    cronExpression: Schema.String,
    timezone: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("interval"), intervalMinutes: Schema.Int }),
]).annotate({ identifier: "HeartbeatSchedule" });

const HeartbeatSuggestion = Schema.Struct({
  resourceId: Schema.String,
  displayName: Schema.String,
  pluginId: PluginId,
  resourceTypeId: Schema.String,
  accountId: Uuid,
  fieldKey: Schema.String.annotate({
    description: "The field the plugin flags as the resource's schedule.",
  }),
  rawSchedule: Schema.String.annotate({ description: "The value as the provider reported it." }),
  schedule: Schema.NullOr(HeartbeatSchedule).annotate({
    description: "The value read as a heartbeat schedule; null when its dialect is not readable.",
  }),
  watchedBy: Schema.Array(Uuid).annotate({
    description: "Heartbeats already watching this resource.",
  }),
}).annotate({ identifier: "HeartbeatSuggestion" });

export const HeartbeatSuggestions = Schema.Struct({
  suggestions: Schema.Array(HeartbeatSuggestion),
}).annotate({ identifier: "HeartbeatSuggestions" });

const HeartbeatPing = Schema.Struct({
  id: Uuid,
  kind: Schema.Literals(["success", "start", "fail"]),
  receivedAt: IsoDateTime,
  durationMs: Schema.NullOr(Schema.Int),
  method: Schema.String,
  userAgent: Schema.NullOr(Schema.String),
  body: Schema.NullOr(Schema.String).annotate({
    description: "The first 1000 characters of the request body, when the job sent one.",
  }),
}).annotate({ identifier: "HeartbeatPing" });

export const HeartbeatPings = Schema.Struct({
  pings: Schema.Array(HeartbeatPing),
}).annotate({ identifier: "HeartbeatPings" });

const HeartbeatParams = { orgId: OrgId, heartbeatId: Uuid } as const;

export class HeartbeatsGroup extends HttpApiGroup.make("heartbeats")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: HeartbeatList,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List heartbeat monitors")
      .annotate(
        OpenApi.Description,
        "Every heartbeat in the organization with its status, schedule, ping URL, last ping " +
          "and next deadline.",
      )
      .annotate(SuccessDescription, "The organization's heartbeats"),
    HttpApiEndpoint.get("suggestions", "/suggestions", {
      params: OrgParams,
      query: {
        resourceId: Schema.optionalKey(
          Schema.String.annotate({ description: "Only this resource's schedule." }),
        ),
      },
      success: HeartbeatSuggestions,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Suggest scheduled resources to watch")
      .annotate(
        OpenApi.Description,
        "Scheduled jobs, pipelines and functions from the organization's synced resources (the " +
          "fields their plugins flag as a schedule), with each schedule read into cron or an " +
          "interval. A read over stored state; no provider API calls.",
      )
      .annotate(SuccessDescription, "Scheduled resources"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: HeartbeatCreate,
      success: Heartbeat.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Create a heartbeat")
      .annotate(
        OpenApi.Description,
        "Create a heartbeat with a schedule and grace period. It stays `new` until its first " +
          "ping, then goes down whenever a ping is later than the schedule plus grace. " +
          "Audit-logged.",
      )
      .annotate(SuccessDescription, "The created heartbeat"),
    HttpApiEndpoint.put("update", "/:heartbeatId", {
      params: HeartbeatParams,
      payload: HeartbeatUpdate,
      success: Heartbeat,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Update, pause or resume a heartbeat")
      .annotate(
        OpenApi.Description,
        "Edit the name, schedule or grace period, or toggle `enabled`. A schedule change " +
          "recomputes the deadline from the last ping. Audit-logged.",
      )
      .annotate(SuccessDescription, "The updated heartbeat"),
    HttpApiEndpoint.post("rotateToken", "/:heartbeatId/rotate-token", {
      params: HeartbeatParams,
      success: Heartbeat,
      error: [NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Replace a heartbeat's ping URL")
      .annotate(
        OpenApi.Description,
        "Issue a new secret ping URL. The old one stops working at once. Audit-logged.",
      )
      .annotate(SuccessDescription, "The heartbeat with its new ping URL"),
    HttpApiEndpoint.delete("delete", "/:heartbeatId", {
      params: HeartbeatParams,
      success: HttpApiSchema.NoContent,
      error: [NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Delete a heartbeat")
      .annotate(OpenApi.Description, "Remove the heartbeat and its ping history. Audit-logged.")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.get("pings", "/:heartbeatId/pings", {
      params: HeartbeatParams,
      query: {
        limit: Schema.optionalKey(
          Schema.NumberFromString.check(
            Schema.isInt(),
            Schema.isBetween({ minimum: 1, maximum: 500 }),
          ).annotate({
            description: "How many pings, newest first. Defaults to 100.",
          }),
        ),
      },
      success: HeartbeatPings,
      error: [NotFound],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Read a heartbeat's ping history")
      .annotate(
        OpenApi.Description,
        "Recent pings, newest first, with each run's duration where a `/start` opened it. " +
          "Kept for 30 days.",
      )
      .annotate(SuccessDescription, "Recent pings"),
  )
  .prefix("/api/org/:orgId/heartbeats")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Heartbeats") {}

const PingAnswer = Schema.String.pipe(HttpApiSchema.asText());
const PingNotFound = Schema.String.pipe(HttpApiSchema.asText(), HttpApiSchema.status(404));
const PingRateLimited = Schema.String.pipe(HttpApiSchema.asText(), HttpApiSchema.status(429));
const PingParams = { token: Schema.String } as const;

const pingDescription = (what: string) =>
  `**Unauthenticated**: the token in the path is the credential. ${what} Answers \`OK\` in ` +
  "plain text; an unknown token answers 404, and more than 20 pings a minute for one heartbeat " +
  "answer 429 without being recorded. A POST body's first 1000 characters are kept with the ping.";

const pingEndpoints = (
  name: "success" | "start" | "fail",
  path: "/:token" | "/:token/start" | "/:token/fail",
  summary: string,
  what: string,
) =>
  [
    HttpApiEndpoint.get(`${name}Get`, path, {
      params: PingParams,
      success: PingAnswer,
      error: [PingNotFound, PingRateLimited],
    })
      .annotate(OpenApi.Summary, `${summary} (GET)`)
      .annotate(OpenApi.Description, pingDescription(what))
      .annotate(SuccessDescription, "Recorded")
      .annotate(Security, []),
    HttpApiEndpoint.post(`${name}Post`, path, {
      params: PingParams,
      success: PingAnswer,
      error: [PingNotFound, PingRateLimited],
    })
      .annotate(OpenApi.Summary, summary)
      .annotate(OpenApi.Description, pingDescription(what))
      .annotate(SuccessDescription, "Recorded")
      .annotate(Security, []),
  ] as const;

/** The public ping URL. No middleware: see the module note. */
export class HeartbeatPingGroup extends HttpApiGroup.make("heartbeatPing")
  .add(
    ...pingEndpoints(
      "success",
      "/:token",
      "Ping a heartbeat",
      "The job ran: the heartbeat is up and its next deadline is set from the schedule.",
    ),
    ...pingEndpoints(
      "start",
      "/:token/start",
      "Signal a run started",
      "Records the start so the closing ping can report the run's duration.",
    ),
    ...pingEndpoints(
      "fail",
      "/:token/fail",
      "Signal a run failed",
      "The heartbeat goes down at once and alerts.",
    ),
  )
  .prefix("/api/ping")
  .annotate(OpenApi.Title, "Heartbeats") {}

export class HeartbeatsApi extends withApiDefaults(
  HttpApi.make("heartbeats").add(HeartbeatsGroup).add(HeartbeatPingGroup),
) {}
