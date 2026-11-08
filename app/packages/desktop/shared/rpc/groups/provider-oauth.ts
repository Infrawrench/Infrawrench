/**
 * Provider OAuth ("Connect with X") for the desktop GUI
 * (`electron/provider-oauth/connect.ts`).
 *
 * - `ProviderOAuthLocalClients`: plugins a LOCAL account can connect (the
 *   manifest declares a desktop client and this build carries its id).
 * - `ProviderOAuthConnect`: run one flow and answer with the credentials to
 *   merge into the form. `target: "local"` runs the native-app flow here
 *   (loopback redirect, PKCE, public client); `target: "cloud"` asks the
 *   server to run its flow and waits for its `infrawrench://provider-oauth`
 *   link. One flow at a time: starting another cancels the first, which then
 *   fails with `ProviderOAuthCancelled`, as it does after
 *   `ProviderOAuthCancel` or when the call is interrupted.
 * - `ProviderOAuthStatusChanges`: a local account's connection changed state
 *   in the main process (a refresh was rejected, a reconnect succeeded).
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

/** `ProviderOAuthResult` in `@infrawrench/ui`, which the renderer returns it as. */
export const ProviderOAuthResult = Schema.Struct({
  credentials: Schema.Record(Schema.String, Schema.String),
  accountName: Schema.optionalKey(Schema.String),
});

/** Why the flow failed, in a sentence for the form. */
export class ProviderOAuthError extends Schema.TaggedError<ProviderOAuthError>()(
  "ProviderOAuthError",
  { message: Schema.String },
) {}

/** The user (or a newer flow) cancelled; the form goes quietly back to idle. */
export class ProviderOAuthCancelled extends Schema.TaggedError<ProviderOAuthCancelled>()(
  "ProviderOAuthCancelled",
  { message: Schema.String },
) {}

export const ProviderOAuthStatusChange = Schema.Struct({
  accountId: Schema.String,
  status: Schema.Literals(["connected", "reconnect_required"]),
});

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

export class ProviderOAuthRpcs extends RpcGroup.make(
  Rpc.make("ProviderOAuthLocalClients", { success: Schema.Array(Schema.String) }),
  Rpc.make("ProviderOAuthConnect", {
    payload: Schema.Union([
      Schema.Struct({ target: Schema.Literal("local"), pluginId: Id }),
      Schema.Struct({
        target: Schema.Literal("cloud"),
        pluginId: Id,
        orgId: Id,
        accountId: Schema.optionalKey(Id),
      }),
    ]),
    success: ProviderOAuthResult,
    error: Schema.Union([ProviderOAuthError, ProviderOAuthCancelled]),
  }),
  Rpc.make("ProviderOAuthCancel"),
  Rpc.make("ProviderOAuthStatusChanges", { success: ProviderOAuthStatusChange, stream: true }),
) {}
