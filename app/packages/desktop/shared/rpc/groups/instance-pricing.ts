/**
 * The instance pricing warehouse (the data behind instances.infrawrench.com),
 * reached from the main process because it needs no signed-in account and the
 * renderer's CSP stays closed to the cloud host.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type { InstancePricingResult as InstancePricingResultType } from "@infrawrench/client-core";
import { exact } from "../exact";

const InstancePricingCell = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.Null,
]);

export const InstancePricingResult = exact<InstancePricingResultType>()(
  Schema.Struct({
    columns: Schema.mutable(
      Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String })),
    ),
    rows: Schema.mutable(Schema.Array(Schema.mutable(Schema.Array(InstancePricingCell)))),
    truncated: Schema.Boolean,
    elapsedMs: Schema.Finite,
  }),
);

/** The warehouse refused the statement or could not be reached; the message is its own. */
export class InstancePricingError extends Schema.TaggedError<InstancePricingError>()(
  "InstancePricingError",
  { message: Schema.String },
) {}

export class InstancePricingRpcs extends RpcGroup.make(
  Rpc.make("InstancePricingQuery", {
    payload: { sql: Schema.String, maxRows: Schema.Int },
    success: InstancePricingResult,
    error: InstancePricingError,
  }),
) {}
