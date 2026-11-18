/**
 * Migration estimate bodies (POST/PUT /migration-estimates, POST
 * /migration-estimates/preview), as Effect schemas the editor and the API
 * share.
 */
import { Effect, Schema } from "effect";
import {
  MIGRATION_ESTIMATE_LIMITS,
  type MigrationEstimateInput as MigrationEstimateInputContract,
} from "@infrawrench/client-core";
import { maxLength, minLength } from "./checks";
import type { Exact } from "./contract";
import { IsoDate, NonEmptyString } from "./primitives";

export const MigrationEstimateSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("service"),
    serviceId: NonEmptyString.annotate({ description: "The service's id or slug." }),
  }),
  Schema.Struct({
    kind: Schema.Literal("resources"),
    resourceIds: Schema.mutable(Schema.Array(NonEmptyString)).check(
      minLength(1),
      maxLength(MIGRATION_ESTIMATE_LIMITS.maxResources),
    ),
  }),
]).annotate({
  identifier: "MigrationEstimateSource",
  description:
    "What to price: a service's members (resolved on every read, so the estimate follows " +
    "the service) or a set of resource ids.",
});

export const MigrationRowOverride = Schema.Struct({
  resourceTypeId: Schema.optionalKey(
    NonEmptyString.annotate({ description: "Target resource type, of the row's category." }),
  ),
  sizeId: Schema.optionalKey(
    NonEmptyString.annotate({ description: "Target size: a catalog SKU or size-picker id." }),
  ),
}).annotate({ identifier: "MigrationRowOverride" });

export const MigrationEstimateInput = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(MIGRATION_ESTIMATE_LIMITS.maxNameLength)),
  source: MigrationEstimateSource,
  targetPluginId: NonEmptyString.annotate({
    description: "The provider to price on, as a plugin id (`hetzner`, `gcp`).",
  }),
  targetRegion: Schema.NullOr(Schema.String)
    .annotate({
      description:
        "A region of the target provider, or null for the one nearest the source resources.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  overrides: Schema.Record(Schema.String, MigrationRowOverride)
    .annotate({
      description: "Per source resource id, the user's target type and size in place of the match.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => ({})))),
}).annotate({ identifier: "MigrationEstimateInput" });

/** Turning an estimate into a scenario model. */
export const MigrationScenarioInput = Schema.Struct({
  startDate: IsoDate.annotate({
    description: "The day the migration lands: the scenario's recurring change starts here.",
  }),
  name: Schema.optionalKey(
    Schema.String.check(minLength(1), maxLength(120)).annotate({
      description: "The scenario model's name. Defaults to the estimate's name and target.",
    }),
  ),
}).annotate({ identifier: "MigrationScenarioInput" });

export type MigrationEstimateSchemasMatchContract = [
  Exact<typeof MigrationEstimateInput.Type, MigrationEstimateInputContract>,
];
[true] satisfies MigrationEstimateSchemasMatchContract;
