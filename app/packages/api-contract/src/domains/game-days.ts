/**
 * Game days: `/api/org/:orgId/game-days`, the endpoint definitions.
 *
 * A game day is a planned, controlled failure: a reversible failure action
 * (declared by the resource's plugin) injected at a scheduled start and undone
 * at a time limit, while the product records which detectors noticed and how
 * fast. The poller does the injecting, watching and undoing; these routes
 * plan, confirm, stop and report.
 *
 * Permissions: reading is `game-days:read` (members). Planning, arming, ending
 * and retrying an undo are `game-days:run` (admins and owners). Aborting is
 * `game-days:read` on purpose: stopping an experiment only ever puts things
 * back, and whoever sees customers hurting first should be able to press it.
 * Arming additionally refuses API keys and agents: a game day never runs
 * without a person having confirmed it.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  GAME_DAY_END_REASONS,
  GAME_DAY_STATUSES,
  GAME_DAY_TARGET_STATES,
} from "@infrawrench/client-core";
import { GameDayInput, STRICT_PARSE_OPTIONS } from "../schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, Forbidden, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, Ok, OrgId, OrgParams, Uuid } from "../http/schemas/common";
import { PluginId } from "../http/schemas/plugin-registry";

const strictBody = { ...STRICT_PARSE_OPTIONS, errors: "all" } as const;

const GameDayStatus = Schema.Literals(GAME_DAY_STATUSES).annotate({
  identifier: "GameDayStatus",
  description:
    "`planned` (written, not confirmed), `armed` (confirmed; injects at `startsAt`), " +
    "`injecting`, `running` (the failure is in effect), `reverting`, `recovering` (undone; " +
    "waiting for the watched probes), `completed`, `cancelled` (never injected) or " +
    "`undo_failed` (the undo kept failing: the resource may still be broken).",
});

const GameDayEndReason = Schema.Literals(GAME_DAY_END_REASONS).annotate({
  identifier: "GameDayEndReason",
  description:
    "`time_limit`, `ended` (somebody ended it early), `aborted`, `inject_failed` (an inject " +
    "failed, so everything injected was undone), `interrupted` (found mid-injection after a " +
    "restart, so undone rather than resumed) or `freeze` (a change freeze was in effect at the " +
    "start).",
});

const Instant = Schema.NullOr(IsoDateTime);

export const GameDayTarget = Schema.Struct({
  id: Uuid,
  resourceId: Schema.String,
  accountId: Uuid,
  pluginId: PluginId,
  resourceTypeId: Schema.String,
  displayName: Schema.String,
  actionId: Schema.String,
  actionLabel: Schema.String,
  undoLabel: Schema.String,
  state: Schema.Literals(GAME_DAY_TARGET_STATES),
  stateBefore: Schema.NullOr(Schema.String).annotate({
    description: 'What the plugin reported before the inject, e.g. "3 replicas".',
  }),
  injectedAt: Instant,
  revertedAt: Instant,
  attempts: Schema.Int,
  lastError: Schema.NullOr(Schema.String),
}).annotate({ identifier: "GameDayTarget" });

export const GameDaySignals = Schema.Struct({
  probeFailedAt: Instant,
  probeDownAt: Instant,
  metricAlertAt: Instant,
  sloBurnAt: Instant,
  incidentDeclaredAt: Instant,
  alertedAt: Instant,
  pagedAt: Instant,
  acknowledgedAt: Instant,
}).annotate({
  identifier: "GameDaySignals",
  description: "When each detector first noticed; null where it did not.",
});

const WatchedProbe = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  status: Schema.Literals(["up", "down", "unknown"]),
}).annotate({ identifier: "GameDayWatchedProbe" });

export const GameDay = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  serviceId: Schema.NullOr(Uuid),
  serviceName: Schema.NullOr(Schema.String),
  status: GameDayStatus,
  endReason: Schema.NullOr(GameDayEndReason),
  startsAt: IsoDateTime,
  durationMinutes: Schema.Int,
  recoveryTimeoutMinutes: Schema.Int,
  freezeDuringRun: Schema.Boolean,
  freezeId: Schema.NullOr(Uuid),
  watchedProbes: Schema.Array(WatchedProbe),
  watchedSloIds: Schema.Array(Uuid),
  armedAt: Instant,
  armedByUserId: Schema.NullOr(Schema.String),
  armedByEmail: Schema.NullOr(Schema.String),
  injectedAt: Instant,
  endsAt: Instant.annotate({ description: "The time limit, once injected." }),
  endRequestedAt: Instant,
  undoneAt: Instant,
  recoveredAt: Instant,
  completedAt: Instant,
  lastError: Schema.NullOr(Schema.String),
  signals: GameDaySignals,
  targets: Schema.Array(GameDayTarget),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "GameDay" });

export const GameDayList = Schema.Struct({ gameDays: Schema.Array(GameDay) }).annotate({
  identifier: "GameDayList",
});

const GameDayDetectorName = Schema.Literals([
  "probe_failure",
  "probe_alert",
  "metric_alert",
  "slo_burn",
  "incident",
  "alert",
  "page",
  "acknowledge",
]);

export const GameDayReport = Schema.Struct({
  timeToDetectMs: Schema.NullOr(Schema.Finite),
  timeToPageMs: Schema.NullOr(Schema.Finite),
  timeToAcknowledgeMs: Schema.NullOr(Schema.Finite).annotate({
    description: "From the page (or the first alert, when nothing paged) to its acknowledgement.",
  }),
  timeToRecoverMs: Schema.NullOr(Schema.Finite).annotate({
    description: "From the undo to the watched probes green again.",
  }),
  injectedForMs: Schema.NullOr(Schema.Finite),
  detectedBy: Schema.NullOr(GameDayDetectorName),
  detectors: Schema.Array(
    Schema.Struct({
      detector: GameDayDetectorName,
      at: Instant,
      afterMs: Schema.NullOr(Schema.Finite),
      measurable: Schema.Boolean.annotate({
        description: "False when nothing was set up that could fire it.",
      }),
    }),
  ),
  state: Schema.Literals(["final", "in_progress", "not_run"]),
}).annotate({
  identifier: "GameDayReport",
  description: "Computed from the stored timestamps by client-core's `computeGameDayReport`.",
});

export const GameDayAlert = Schema.Struct({
  id: Uuid,
  at: IsoDateTime,
  trigger: Schema.String,
  severity: Schema.String,
  title: Schema.String,
  related: Schema.Boolean.annotate({
    description:
      "About a target, a member of the service, a watched probe or SLO, or a declared incident.",
  }),
  paged: Schema.Boolean.annotate({
    description: "Routed to an on-call rotation or a paging provider.",
  }),
  unrouted: Schema.Boolean.annotate({ description: "No routing rule sent it anywhere." }),
}).annotate({ identifier: "GameDayAlert" });

export const GameDayDetail = Schema.Struct({
  gameDay: GameDay,
  alerts: Schema.Array(GameDayAlert).annotate({
    description: "Alerts the routing rules handled while the game day ran, oldest first.",
  }),
  report: GameDayReport,
}).annotate({ identifier: "GameDayDetail" });

const FailureOption = Schema.Struct({
  actionId: Schema.String,
  label: Schema.String,
  undoLabel: Schema.String,
  description: Schema.NullOr(Schema.String),
});

export const GameDayCandidates = Schema.Struct({
  resources: Schema.Array(
    Schema.Struct({
      resourceId: Schema.String,
      accountId: Uuid,
      pluginId: PluginId,
      resourceTypeId: Schema.String,
      displayName: Schema.String,
      actions: Schema.Array(FailureOption),
    }),
  ),
  services: Schema.Array(
    Schema.Struct({ id: Uuid, name: Schema.String, resourceIds: Schema.Array(Schema.String) }),
  ),
  probes: Schema.Array(WatchedProbe),
  slos: Schema.Array(Schema.Struct({ id: Uuid, name: Schema.String })),
}).annotate({ identifier: "GameDayCandidates" });

export const GameDayPlan = Schema.Struct({
  steps: Schema.Array(
    Schema.Struct({
      resourceId: Schema.String,
      displayName: Schema.String,
      pluginId: PluginId,
      actionId: Schema.String,
      actionLabel: Schema.String,
      undoLabel: Schema.String,
      outcome: Schema.Literals(["inject", "skip", "blocked"]),
      currentState: Schema.NullOr(Schema.String),
      problem: Schema.NullOr(Schema.String),
    }),
  ),
  blockingFreeze: Schema.NullOr(Schema.Struct({ id: Uuid, name: Schema.String })),
  unmeasured: Schema.Array(GameDayDetectorName),
}).annotate({ identifier: "GameDayPlan" });

const GameDayArmRequest = Schema.Struct({
  confirmName: Schema.String.annotate({
    description: "The game day's name, typed by the person arming it.",
  }),
}).annotate({ identifier: "GameDayArmRequest" });

const GameDayParams = { orgId: OrgId, gameDayId: Uuid } as const;

const action = <const Name extends string, const Path extends `/${string}`>(
  name: Name,
  path: Path,
  permission: string,
  summary: string,
  text: string,
) =>
  HttpApiEndpoint.post(name, path, {
    params: GameDayParams,
    success: GameDay,
    error: [Conflict, NotFound],
  })
    .annotate(RequiredPermission, permission)
    .annotate(OpenApi.Summary, summary)
    .annotate(OpenApi.Description, text)
    .annotate(SuccessDescription, "The game day");

export class GameDaysGroup extends HttpApiGroup.make("gameDays")
  .add(
    HttpApiEndpoint.get("list", "/", { params: OrgParams, success: GameDayList })
      .annotate(RequiredPermission, "game-days:read")
      .annotate(OpenApi.Summary, "List game days")
      .annotate(
        OpenApi.Description,
        "Every game day, newest start first, with its targets and the detection timestamps " +
          "recorded so far.",
      )
      .annotate(SuccessDescription, "The game days"),
    HttpApiEndpoint.get("candidates", "/candidates", {
      params: OrgParams,
      success: GameDayCandidates,
    })
      .annotate(RequiredPermission, "game-days:read")
      .annotate(OpenApi.Summary, "List what a game day can target and watch")
      .annotate(
        OpenApi.Description,
        "Synced resources whose plugin declares a reversible failure action for their type (with " +
          "the actions), services with their members, probes and SLOs. Feeds the editor's pickers.",
      )
      .annotate(SuccessDescription, "Targets, services, probes and SLOs"),
    HttpApiEndpoint.post("plan", "/plan", {
      params: OrgParams,
      payload: GameDayInput,
      success: GameDayPlan,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "game-days:run")
      .annotate(InvalidRequestMessage, "Invalid game day")
      .annotate(HttpApi.PayloadParseOptions, strictBody)
      .annotate(OpenApi.Summary, "Dry-run a game day")
      .annotate(
        OpenApi.Description,
        "What injecting this game day would do right now, without changing anything: each " +
          "target's current state as its provider reports it, the ones that would be skipped or " +
          "cannot run, a change freeze that would stop it, and detectors nothing is set up to " +
          "measure. A read despite the method.",
      )
      .annotate(SuccessDescription, "The plan"),
    HttpApiEndpoint.get("get", "/:gameDayId", {
      params: GameDayParams,
      success: GameDayDetail,
      error: NotFound,
    })
      .annotate(RequiredPermission, "game-days:read")
      .annotate(OpenApi.Summary, "Read a game day with its report")
      .annotate(SuccessDescription, "The game day"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: GameDayInput,
      success: GameDay,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "game-days:run")
      .annotate(InvalidRequestMessage, "Invalid game day")
      .annotate(HttpApi.PayloadParseOptions, strictBody)
      .annotate(OpenApi.Summary, "Plan a game day")
      .annotate(
        OpenApi.Description,
        "Stored as `planned`: nothing happens until a person arms it. Every target must be a " +
          "synced resource whose plugin declares the named failure action. Audit-logged.",
      )
      .annotate(SuccessDescription, "The planned game day"),
    HttpApiEndpoint.put("update", "/:gameDayId", {
      params: GameDayParams,
      payload: GameDayInput,
      success: GameDay,
      error: [BadRequest, Conflict, NotFound],
    })
      .annotate(RequiredPermission, "game-days:run")
      .annotate(InvalidRequestMessage, "Invalid game day")
      .annotate(HttpApi.PayloadParseOptions, strictBody)
      .annotate(OpenApi.Summary, "Replace a planned game day")
      .annotate(
        OpenApi.Description,
        "Only a `planned` game day can be edited; disarm an armed one first. Audit-logged.",
      )
      .annotate(SuccessDescription, "The game day"),
    HttpApiEndpoint.delete("delete", "/:gameDayId", {
      params: GameDayParams,
      success: Ok,
      error: [Conflict, NotFound],
    })
      .annotate(RequiredPermission, "game-days:run")
      .annotate(OpenApi.Summary, "Delete a game day")
      .annotate(
        OpenApi.Description,
        "Refused while it is armed or the failure may be in effect. Audit-logged.",
      )
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.post("arm", "/:gameDayId/arm", {
      params: GameDayParams,
      payload: GameDayArmRequest,
      success: GameDay,
      error: [BadRequest, Conflict, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "game-days:run")
      .annotate(HttpApi.PayloadParseOptions, strictBody)
      .annotate(OpenApi.Summary, "Arm a game day")
      .annotate(
        OpenApi.Description,
        "The confirmation: `confirmName` must repeat the game day's name. The failure is " +
          "injected at `startsAt`, or straight away when that has passed. Refused to API keys " +
          "and agents: a person confirms every game day. Audit-logged.",
      )
      .annotate(SuccessDescription, "The armed game day"),
    action(
      "disarm",
      "/:gameDayId/disarm",
      "game-days:run",
      "Disarm a game day",
      "Back to `planned` before it starts. Audit-logged.",
    ),
    action(
      "end",
      "/:gameDayId/end",
      "game-days:run",
      "End a game day now",
      "Undo the failure before its time limit, recorded as ended rather than aborted. " +
        "Audit-logged.",
    ),
    action(
      "abort",
      "/:gameDayId/abort",
      "game-days:read",
      "Abort a game day",
      "Undo the failure now, or cancel an armed game day that has not started. Open to every " +
        "member: stopping an experiment only ever puts things back. Audit-logged.",
    ),
    action(
      "retryUndo",
      "/:gameDayId/retry-undo",
      "game-days:run",
      "Retry a failed undo",
      "Put an `undo_failed` game day back to undoing, with its attempts reset. Audit-logged.",
    ),
  )
  .prefix("/api/org/:orgId/game-days")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Game days") {}

export class GameDaysApi extends withApiDefaults(HttpApi.make("gameDays").add(GameDaysGroup)) {}
