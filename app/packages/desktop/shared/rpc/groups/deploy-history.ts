/**
 * Local deploy history: what `infrawrench deploy` did on this machine (see
 * `electron/deploy-history.ts` for why it is a file rather than a table).
 * Read-only from the renderer: only the CLI deploys locally.
 */
import { Effect, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type { LocalDeployRun as LocalDeployRunType } from "../../../src/lib/deploy-history-types";
import { exact } from "../exact";

const CreatedResource = exact<LocalDeployRunType["createdResources"][number]>()(
  Schema.Struct({
    pluginId: Schema.String,
    accountId: Schema.String,
    resourceTypeId: Schema.String,
    resourceId: Schema.String,
    externalId: Schema.optionalKey(Schema.String),
    displayName: Schema.String,
    sidecar: Schema.optionalKey(
      Schema.Struct({ pluginId: Schema.String, parentResourceId: Schema.String }),
    ),
  }),
);

/**
 * One run, as the history file stores it. The main process decodes every line
 * with this, so a line written by an older build (or cut short) costs that
 * entry rather than the whole history.
 */
export const LocalDeployRun = exact<LocalDeployRunType>()(
  Schema.Struct({
    id: Schema.String,
    startedAt: Schema.String,
    env: Schema.String,
    repo: Schema.NullOr(Schema.String),
    branch: Schema.NullOr(Schema.String),
    gitSha: Schema.NullOr(Schema.String),
    dirty: Schema.Boolean,
    image: Schema.NullOr(Schema.String),
    status: Schema.Literals(["success", "failure", "canceled", "running", "pending"]),
    stage: Schema.NullOr(Schema.String),
    durationMs: Schema.NullOr(Schema.Finite),
    dir: Schema.String,
    notes: Schema.mutable(Schema.Array(Schema.String)),
    createdResources: Schema.mutable(Schema.Array(CreatedResource)),
    error: Schema.NullOr(Schema.String),
    orgId: Schema.NullOr(Schema.String),
    plan: Schema.optionalKey(Schema.Unknown),
    output: Schema.optionalKey(Schema.Unknown),
  }),
);

/**
 * A run as stored, one JSON line each. `createdResources` arrived on
 * 2026-07-30: a line written before then has none, and reads as an empty list
 * rather than being dropped from the history.
 */
export const StoredLocalDeployRun = Schema.Struct({
  ...LocalDeployRun.fields,
  createdResources: Schema.mutable(Schema.Array(CreatedResource)).pipe(
    Schema.withDecodingDefaultKey(Effect.sync(() => [])),
  ),
});

export class LocalDeployHistoryRpcs extends RpcGroup.make(
  Rpc.make("LocalDeployHistory", { success: Schema.mutable(Schema.Array(LocalDeployRun)) }),
) {}
