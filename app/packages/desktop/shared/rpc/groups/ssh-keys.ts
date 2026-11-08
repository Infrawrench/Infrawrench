/**
 * The user's own SSH keys: private keys in `~/.ssh`, and the external agents
 * (Pageant on Windows, 1Password anywhere) the key pickers offer beside them.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { SshError } from "./ssh-common";

/** A public key an external agent holds, in OpenSSH form. */
export const AgentSshKey = Schema.Struct({
  name: Schema.String,
  publicKey: Schema.String,
  /** OpenSSH algorithm name, e.g. `ssh-ed25519`. */
  keyType: Schema.String,
});
export type AgentSshKey = typeof AgentSshKey.Type;

export class SshKeyRpcs extends RpcGroup.make(
  /**
   * Private keys in `~/.ssh` (by PEM header). Listing a key is what lets
   * `SshReadSystemKey` read it, and its `.pub`, without a confirm dialog.
   */
  Rpc.make("SshListSystemKeys", {
    success: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
  /**
   * Read `~/.ssh/<name>` (the basename only). A name the last listing did not
   * return asks the user first; a denial fails with `SshError`.
   */
  Rpc.make("SshReadSystemKey", {
    payload: { name: Schema.String },
    success: Schema.String,
    error: SshError,
  }),
  Rpc.make("SshCheckPageant", { success: Schema.Boolean }),
  Rpc.make("SshCheck1Password", { success: Schema.Boolean }),
  /** The keys 1Password's agent holds; empty when it is absent or slow. */
  Rpc.make("SshList1PasswordKeys", { success: Schema.Array(AgentSshKey) }),
) {}
