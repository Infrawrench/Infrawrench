/**
 * Local-mode environment diff: two of this machine's accounts, each listed
 * live through its plugin, compared with the cloud's `/environment-diff`
 * computation (see `electron/local-environment-diff.ts`).
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type {
  EnvironmentDiffEntry,
  EnvironmentDiffResourceRef,
  EnvironmentDiffResponse as EnvironmentDiffResponseType,
  EnvironmentDiffSideSummary,
  EnvironmentDiffTotals,
  EnvironmentDiffTypeSummary,
  EnvironmentDiffUnavailableType,
} from "@infrawrench/client-core";
import { exact } from "../exact";

const EnvironmentDiffResourceRef = exact<EnvironmentDiffResourceRef>()(
  Schema.Struct({
    resourceId: Schema.String,
    accountId: Schema.String,
    displayName: Schema.String,
    externalId: Schema.NullOr(Schema.String),
  }),
);

const EnvironmentDiffEntry = exact<EnvironmentDiffEntry>()(
  Schema.Struct({
    key: Schema.String,
    resourceTypeId: Schema.String,
    resourceTypeName: Schema.String,
    status: Schema.Literals(["only-in-a", "only-in-b", "changed"]),
    a: Schema.NullOr(EnvironmentDiffResourceRef),
    b: Schema.NullOr(EnvironmentDiffResourceRef),
    changes: Schema.mutable(
      Schema.Array(Schema.Struct({ field: Schema.String, a: Schema.Unknown, b: Schema.Unknown })),
    ),
    suppressedCount: Schema.Int,
  }),
);

const EnvironmentDiffTypeSummary = exact<EnvironmentDiffTypeSummary>()(
  Schema.Struct({
    resourceTypeId: Schema.String,
    resourceTypeName: Schema.String,
    countA: Schema.Int,
    countB: Schema.Int,
    delta: Schema.Int,
    onlyInA: Schema.Int,
    onlyInB: Schema.Int,
    changed: Schema.Int,
    identical: Schema.Int,
    missingFrom: Schema.NullOr(Schema.Literals(["a", "b"])),
  }),
);

const EnvironmentDiffSideSummary = exact<EnvironmentDiffSideSummary>()(
  Schema.Struct({
    accountId: Schema.String,
    accountName: Schema.String,
    resourceCount: Schema.Int,
  }),
);

const EnvironmentDiffTotals = exact<EnvironmentDiffTotals>()(
  Schema.Struct({
    onlyInA: Schema.Int,
    onlyInB: Schema.Int,
    changed: Schema.Int,
    identical: Schema.Int,
    typesOnlyInA: Schema.Int,
    typesOnlyInB: Schema.Int,
    suppressedFieldChanges: Schema.Int,
  }),
);

const EnvironmentDiffUnavailableType = exact<EnvironmentDiffUnavailableType>()(
  Schema.Struct({
    resourceTypeId: Schema.String,
    resourceTypeName: Schema.String,
    message: Schema.String,
  }),
);

export const EnvironmentDiffResponse = exact<EnvironmentDiffResponseType>()(
  Schema.Struct({
    a: EnvironmentDiffSideSummary,
    b: EnvironmentDiffSideSummary,
    pluginId: Schema.String,
    pluginName: Schema.String,
    types: Schema.mutable(Schema.Array(EnvironmentDiffTypeSummary)),
    entries: Schema.mutable(Schema.Array(EnvironmentDiffEntry)),
    totals: EnvironmentDiffTotals,
    unavailableTypes: Schema.mutable(Schema.Array(EnvironmentDiffUnavailableType)),
    includeIdentityFields: Schema.Boolean,
    generatedAt: Schema.String,
  }),
);

/**
 * Why two accounts could not be compared: one is not in this workspace, they
 * belong to different providers, or a provider could not be reached at all.
 * The message is what the diff panel shows.
 */
export class LocalEnvironmentDiffError extends Schema.TaggedError<LocalEnvironmentDiffError>()(
  "LocalEnvironmentDiffError",
  { message: Schema.String },
) {}

export class LocalEnvironmentDiffRpcs extends RpcGroup.make(
  Rpc.make("LocalEnvironmentDiff", {
    payload: {
      accountIdA: Schema.String,
      accountIdB: Schema.String,
      includeIdentityFields: Schema.Boolean,
    },
    success: EnvironmentDiffResponse,
    error: LocalEnvironmentDiffError,
  }),
) {}
