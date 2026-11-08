/**
 * Org SSH keys: `/api/org/:orgId/ssh-keys`, the endpoint definitions.
 *
 * The request bodies are documented here and read raw by the handlers, which
 * answer a missing or malformed field with their own sentence (and, for
 * `sign`, an audit row), as they always have.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { minLength } from "@infrawrench/ui/schemas";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { Email, IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";

const SshKeyType = Schema.Literals([
  "ssh-rsa",
  "ssh-ed25519",
  "ssh-dss",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
]).annotate({ identifier: "SshKeyType" });

export const SshKey = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  keyType: SshKeyType,
  isImported: Schema.Boolean,
  fingerprint: Schema.NullOr(Schema.String),
  publicKey: Schema.String,
  userId: Uuid,
  ownerEmail: Email,
  ownerName: Schema.String,
  createdAt: IsoDateTime,
}).annotate({ identifier: "SshKey" });

const GenerateSshKeyRequest = Schema.Struct({
  name: Schema.String.check(minLength(1)),
}).annotate({ identifier: "GenerateSshKeyRequest" });

export const GeneratedSshKey = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  keyType: SshKeyType,
  fingerprint: Schema.String,
  publicKey: Schema.String,
  privateKey: Schema.String.annotate({
    description: "Returned once. Not persisted in plaintext.",
  }),
}).annotate({ identifier: "GeneratedSshKey" });

const ImportSshKeyRequest = Schema.Struct({
  name: Schema.String.check(minLength(1)),
  publicKey: Schema.String,
}).annotate({ identifier: "ImportSshKeyRequest" });

export const ImportedSshKey = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  keyType: SshKeyType,
  fingerprint: Schema.String,
  publicKey: Schema.String,
  isImported: Schema.Literal(true),
}).annotate({ identifier: "ImportedSshKey" });

const SshSignAlgorithm = Schema.Literals([
  "ssh-ed25519",
  "ssh-rsa",
  "rsa-sha2-256",
  "rsa-sha2-512",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
]).annotate({ identifier: "SshSignAlgorithm" });

const SignSshKeyRequest = Schema.Struct({
  data: Schema.String.annotate({
    description: "The exact bytes SSH wants signed (a publickey-auth challenge), base64-encoded.",
  }),
  algorithm: SshSignAlgorithm,
  context: Schema.optionalKey(
    Schema.Struct({
      host: Schema.optionalKey(Schema.String),
      username: Schema.optionalKey(Schema.String),
    }).annotate({ description: "Recorded in the audit log entry for this signature." }),
  ),
}).annotate({ identifier: "SignSshKeyRequest" });

export const SignSshKeyResponse = Schema.Struct({
  signature: Schema.String.annotate({
    description:
      "Raw signature bytes, base64-encoded; Ed25519/RSA as-is, ECDSA in DER as node produces it.",
  }),
  algorithm: SshSignAlgorithm,
}).annotate({ identifier: "SignSshKeyResponse" });

export class SshKeysGroup extends HttpApiGroup.make("sshKeys")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(SshKey),
    })
      .annotate(RequiredPermission, "ssh-keys:read")
      .annotate(OpenApi.Summary, "List org SSH keys")
      .annotate(SuccessDescription, "Keys"),
    HttpApiEndpoint.post("generate", "/", {
      params: OrgParams,
      payload: GenerateSshKeyRequest,
      success: GeneratedSshKey,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "ssh-keys:write")
      .annotate(OpenApi.Summary, "Generate a new Ed25519 keypair (private key returned once)")
      .annotate(SuccessDescription, "Generated"),
    HttpApiEndpoint.post("import", "/import", {
      params: OrgParams,
      payload: ImportSshKeyRequest,
      success: ImportedSshKey,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "ssh-keys:write")
      .annotate(OpenApi.Summary, "Import an existing public key")
      .annotate(SuccessDescription, "Imported"),
    // Gated on `resources:execute`, not `ssh-keys:read`: producing an auth
    // signature is the same authority as opening a shell.
    HttpApiEndpoint.post("sign", "/:id/sign", {
      params: OrgIdParams,
      payload: SignSshKeyRequest,
      success: SignSshKeyResponse,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(
        OpenApi.Summary,
        "Sign an SSH auth challenge with a cloud-held key (the cloud as an SSH agent)",
      )
      .annotate(
        OpenApi.Description,
        "Signs one publickey-authentication challenge with a server-generated org key whose " +
          "private half never leaves Infrawrench Cloud. Requires the `resources:execute` " +
          "permission: producing an auth signature is the same authority as opening a shell. " +
          "Imported keys cannot sign (only their public half is stored). Every call is audited.",
      )
      .annotate(SuccessDescription, "Signature"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "ssh-keys:write")
      .annotate(OpenApi.Summary, "Delete an SSH key (owner only)")
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/ssh-keys")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "SSH keys") {}

export class SshKeysApi extends withApiDefaults(HttpApi.make("sshKeys").add(SshKeysGroup)) {}
