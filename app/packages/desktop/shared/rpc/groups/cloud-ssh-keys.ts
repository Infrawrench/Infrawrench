/**
 * The cloud org's SSH keys (`/api/org/:orgId/ssh-keys`), through the main
 * process's signed-in session. A generated key's private half is in the
 * create answer once, exactly as the API returns it.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type { SshKey } from "@infrawrench/client-core";
import { CloudRequestError } from "../errors";
import { exact } from "../exact";

export const CloudSshKey = exact<SshKey>()(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    keyType: Schema.String,
    isImported: Schema.Boolean,
    fingerprint: Schema.NullOr(Schema.String),
    publicKey: Schema.String,
    userId: Schema.String,
    ownerEmail: Schema.String,
    ownerName: Schema.String,
    createdAt: Schema.String,
  }),
);
export type CloudSshKey = typeof CloudSshKey.Type;

/** `POST /ssh-keys`: a fresh Ed25519 pair, the private key returned this once. */
export const GeneratedCloudSshKey = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  keyType: Schema.String,
  fingerprint: Schema.String,
  publicKey: Schema.String,
  privateKey: Schema.String,
});
export type GeneratedCloudSshKey = typeof GeneratedCloudSshKey.Type;

export class CloudSshKeyRpcs extends RpcGroup.make(
  Rpc.make("CloudSshKeysList", {
    payload: { orgId: Schema.String },
    success: Schema.mutable(Schema.Array(CloudSshKey)),
    error: CloudRequestError,
  }),
  Rpc.make("CloudSshKeysCreate", {
    payload: { orgId: Schema.String, name: Schema.String },
    success: GeneratedCloudSshKey,
    error: CloudRequestError,
  }),
  Rpc.make("CloudSshKeysDelete", {
    payload: { orgId: Schema.String, id: Schema.String },
    error: CloudRequestError,
  }),
) {}
