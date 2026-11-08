/**
 * Secrets the renderer stores in the local database, each encrypted with the
 * master key under an AAD bound to its row and field, so a ciphertext copied
 * from one row cannot be decrypted as another:
 *
 * - SSH keys (`ssh_keys`): only the private half is stored; the public key
 *   is derived from it on demand.
 * - An SSH tunnel config's private key (`ssh_tunnel_configs`): the renderer
 *   holds the ciphertext, main encrypts and decrypts it.
 * - Secret resource fields (`secret_field_states`): the same shape, bound to
 *   `(resourceId, fieldKey)`.
 *
 * The renderer never sees the master key.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { MAX_PLAINTEXT_BYTES } from "./local-credentials";

const MAX_CIPHERTEXT_BYTES = 96 * 1024;

const Id = Schema.String.check(Schema.isBetweenLength(1, 128));
const Plaintext = Schema.String.check(Schema.isBetweenLength(1, MAX_PLAINTEXT_BYTES));
const Ciphertext = Schema.String.check(Schema.isMaxLength(MAX_CIPHERTEXT_BYTES));
const Iv = Schema.String.check(Schema.isMaxLength(64));

export const EncryptedValue = Schema.Struct({ ciphertext: Schema.String, iv: Schema.String });
export type EncryptedValue = typeof EncryptedValue.Type;

/** The key Infrawrench generated for agent VMs, with its OpenSSH public half. */
export const AgentSshKey = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  publicKey: Schema.String,
});
export type AgentSshKey = typeof AgentSshKey.Type;

/**
 * Why a secret could not be read or stored: `SSH key not found`, a public
 * key that could not be derived, a ciphertext that does not decrypt under
 * this row's AAD.
 */
export class LocalSecretError extends Schema.TaggedError<LocalSecretError>()("LocalSecretError", {
  message: Schema.String,
}) {}

export class LocalSecretRpcs extends RpcGroup.make(
  Rpc.make("LocalSshKeyPrivateKey", {
    payload: { keyId: Id },
    success: Schema.String,
    error: LocalSecretError,
  }),
  /** `<type> <base64>`, derived from the stored private key. */
  Rpc.make("LocalSshKeyPublicKey", {
    payload: { keyId: Id },
    success: Schema.String,
    error: LocalSecretError,
  }),
  /** The `infrawrench-agent` key, generated (ed25519) and stored on first use. */
  Rpc.make("LocalSshKeyEnsureAgentKey", {
    success: AgentSshKey,
    error: LocalSecretError,
  }),
  Rpc.make("LocalSshKeySave", {
    payload: {
      keyId: Id,
      name: Schema.String.check(Schema.isBetweenLength(1, 256)),
      privateKey: Plaintext,
    },
    error: LocalSecretError,
  }),
  Rpc.make("LocalTunnelConfigKeyDecrypt", {
    payload: { tunnelConfigId: Id, ciphertext: Ciphertext, iv: Iv },
    success: Schema.String,
    error: LocalSecretError,
  }),
  Rpc.make("LocalTunnelConfigKeyEncrypt", {
    payload: { tunnelConfigId: Id, privateKey: Plaintext },
    success: EncryptedValue,
    error: LocalSecretError,
  }),
  /**
   * Shaped like an oracle (the renderer supplies the ciphertext), but the AAD
   * binds each call to one `(resourceId, fieldKey)`, so a ciphertext cannot
   * be swapped across fields or rows.
   */
  Rpc.make("LocalSecretFieldDecrypt", {
    payload: {
      resourceId: Schema.String.check(Schema.isBetweenLength(1, 256)),
      fieldKey: Id,
      ciphertext: Ciphertext,
      iv: Iv,
    },
    success: Schema.String,
    error: LocalSecretError,
  }),
  Rpc.make("LocalSecretFieldEncrypt", {
    payload: {
      resourceId: Schema.String.check(Schema.isBetweenLength(1, 256)),
      fieldKey: Id,
      plaintext: Schema.String.check(Schema.isMaxLength(MAX_PLAINTEXT_BYTES)),
    },
    success: EncryptedValue,
    error: LocalSecretError,
  }),
) {}
