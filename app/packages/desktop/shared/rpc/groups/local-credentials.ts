/**
 * A local account's credentials: read (decrypted, an OAuth grant refreshed
 * and its refresh token withheld), replaced, or stored with a new account.
 *
 * They are encrypted at rest in `accounts.encrypted_credentials` with the
 * master key and an AAD bound to the account's row; the renderer never sees
 * the key, only the plaintext of the account it asked for.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

/** Fits PEM keys and credential JSON; the same cap the stored plaintext has. */
export const MAX_PLAINTEXT_BYTES = 64 * 1024;

const Id = Schema.String.check(Schema.isBetweenLength(1, 128));

/** Credential field name to value; a value is capped at {@link MAX_PLAINTEXT_BYTES}. */
const Credentials = Schema.Record(
  Schema.String,
  Schema.String.check(Schema.isMaxLength(MAX_PLAINTEXT_BYTES)),
);

/**
 * Why the credentials could not be read or stored, as the sentence a toast
 * shows: `Account not found`, an OAuth grant that needs reconnecting, a
 * local-exec consent the user declined.
 */
export class LocalCredentialsError extends Schema.TaggedError<LocalCredentialsError>()(
  "LocalCredentialsError",
  { message: Schema.String },
) {}

export class LocalCredentialRpcs extends RpcGroup.make(
  /**
   * `refresh: false` skips refreshing an OAuth access token: the credentials
   * editor must open even when the grant was revoked and a refresh can only
   * fail.
   */
  Rpc.make("LocalAccountCredentials", {
    payload: { accountId: Id, refresh: Schema.optionalKey(Schema.Boolean) },
    success: Schema.Record(Schema.String, Schema.String),
    error: LocalCredentialsError,
  }),
  Rpc.make("LocalAccountSaveCredentials", {
    payload: { accountId: Id, credentials: Credentials },
    error: LocalCredentialsError,
  }),
  Rpc.make("LocalAccountCreate", {
    payload: {
      accountId: Id,
      pluginId: Id,
      displayName: Schema.String.check(Schema.isBetweenLength(1, 256)),
      credentials: Credentials,
    },
    error: LocalCredentialsError,
  }),
) {}
