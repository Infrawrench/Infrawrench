/**
 * Game days (client-core `game-days.ts`), as Effect schemas: the body the
 * editor validates and the API decodes when a game day is written or dry-run.
 *
 * Bounds come from `GAME_DAY_LIMITS` so the editor, the API and the CLI refuse
 * the same values. What can only be checked against the organization (the
 * resources exist, the failure action is one their plugin declares, the
 * service and probes are the org's) is the store's job.
 */
import { Effect, Schema } from "effect";
import {
  GAME_DAY_LIMITS,
  type GameDayInput as GameDayInputContract,
  type GameDayTargetInput as GameDayTargetInputContract,
} from "@infrawrench/client-core";
import { maxLength, minLength } from "./checks";
import type { Exact } from "./contract";
import { NonEmptyString } from "./primitives";

const L = GAME_DAY_LIMITS;

const between = (minimum: number, maximum: number) => Schema.isBetween({ minimum, maximum });

const Id = Schema.String.check(minLength(1), maxLength(512));

export const GameDayTargetInput = Schema.Struct({
  resourceId: Id.annotate({ description: "A synced resource in the organization." }),
  actionId: NonEmptyString.annotate({
    description:
      "One of the failure actions the resource's plugin declares for its type, as " +
      "`/game-days/candidates` lists them (`stop`, `scale-to-zero`, ...).",
  }),
}).annotate({ identifier: "GameDayTargetInput" });

const IdList = (max: number, description: string) =>
  Schema.mutable(Schema.Array(Id).check(maxLength(max)))
    .annotate({ description, default: [] })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([])));

export const GameDayInput = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(L.nameMax), Schema.isTrimmed()).annotate({
    description: `At most ${L.nameMax} characters.`,
  }),
  description: Schema.NullOr(Schema.String.check(maxLength(L.descriptionMax)))
    .annotate({ description: "The hypothesis being tested, in prose.", default: null })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  serviceId: Schema.NullOr(Id)
    .annotate({
      description:
        "The service the game day exercises. Alerts about any of its members count as detection.",
      default: null,
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  targets: Schema.mutable(
    Schema.Array(GameDayTargetInput).check(minLength(1), maxLength(L.targetsMax)),
  ).annotate({ description: "What to break, and how. Each resource at most once." }),
  startsAt: Schema.String.annotate({
    format: "date-time",
    description:
      `When the failure is injected, ISO 8601. At most ${L.scheduleAheadDaysMax} days ahead; ` +
      "a game day armed after its start is injected straight away.",
  }),
  durationMinutes: Schema.Int.check(between(L.durationMinutesMin, L.durationMinutesMax)).annotate({
    description:
      "The time limit: the failure is undone this long after it was injected, whatever else happens.",
  }),
  recoveryTimeoutMinutes: Schema.Int.check(
    between(L.recoveryTimeoutMinutesMin, L.recoveryTimeoutMinutesMax),
  )
    .annotate({
      description:
        "How long after the undo the watched probes have to go green before recovery is reported " +
        "as not confirmed.",
      default: L.recoveryTimeoutMinutesDefault,
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(L.recoveryTimeoutMinutesDefault))),
  freezeDuringRun: Schema.Boolean.annotate({
    description:
      "Open an org change freeze when the failure is injected, ended when the game day completes.",
    default: false,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  watchedProbeIds: IdList(
    L.watchedProbesMax,
    "Synthetic probes whose failures count as detection and whose recovery confirms the undo.",
  ),
  watchedSloIds: IdList(L.watchedProbesMax, "SLOs whose burn-rate alerts count as detection."),
}).annotate({ identifier: "GameDayInput" });

type GameDaySchemasMatchContract = [
  Exact<typeof GameDayTargetInput.Type, GameDayTargetInputContract>,
  Exact<typeof GameDayInput.Type, GameDayInputContract>,
];
[true, true] satisfies GameDaySchemasMatchContract;
