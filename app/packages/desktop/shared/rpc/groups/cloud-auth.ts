/**
 * Signing in to Infrawrench Cloud: the PKCE flow in the system browser, the
 * session's status and organizations, the cloud's URL, and the short-lived
 * WebSocket token. Tokens stay in the main process; the one exception is the
 * single-use `?token=` for a WebSocket upgrade, which the renderer opens
 * itself and which crossed IPC the same way before.
 *
 * Sign-in failures happen in the protocol callback, long after
 * `CloudAuthStart` answered, so they reach the renderer as a subscription:
 * `CloudAuthErrors` streams each one to every window holding it open.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type { CloudOrg as CloudOrgType } from "@infrawrench/client-core";
import { CloudRequestError } from "../errors";
import { exact } from "../exact";

export const CloudAuthStatus = Schema.Struct({
  authenticated: Schema.Boolean,
  email: Schema.optionalKey(Schema.String),
  organizationId: Schema.optionalKey(Schema.String),
});
export type CloudAuthStatus = typeof CloudAuthStatus.Type;

export const CloudOrg = exact<CloudOrgType>()(
  Schema.Struct({ id: Schema.String, displayName: Schema.String, role: Schema.String }),
);

/** A sign-in that failed in the callback: `missing-code`, `state-mismatch`, `token-exchange`, a refresh. */
export const CloudAuthFailure = Schema.Struct({ code: Schema.String, message: Schema.String });
export type CloudAuthFailure = typeof CloudAuthFailure.Type;

export class CloudAuthRpcs extends RpcGroup.make(
  /** Opens the authorize URL in the browser; the result arrives on the protocol callback. */
  Rpc.make("CloudAuthStart"),
  Rpc.make("CloudAuthStatus", { success: CloudAuthStatus }),
  /** `[]` when signed out; a network or server failure is an error, not an empty list. */
  Rpc.make("CloudAuthOrgs", {
    success: Schema.mutable(Schema.Array(CloudOrg)),
    error: CloudRequestError,
  }),
  Rpc.make("CloudUrl", { success: Schema.String }),
  /** Null when signed out or the server would not mint one. */
  Rpc.make("CloudWsToken", {
    payload: { orgId: Schema.String },
    success: Schema.NullOr(Schema.String),
    error: CloudRequestError,
  }),
  Rpc.make("CloudAuthErrors", { success: CloudAuthFailure, stream: true }),
) {}
