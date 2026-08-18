import { z } from "../zod";
import { strict, ErrorResponses, Uuid, Ok, OrgIdParam, IsoDateTime, Email } from "../common";
import type { BuildContext } from "../context";

const SshKeyType = z
  .enum([
    "ssh-rsa",
    "ssh-ed25519",
    "ssh-dss",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ssh-ed25519@openssh.com",
    "sk-ecdsa-sha2-nistp256@openssh.com",
  ])
  .openapi("SshKeyType");

const SshKey = strict({
  id: Uuid,
  name: z.string(),
  keyType: SshKeyType,
  isImported: z.boolean(),
  fingerprint: z.string().nullable(),
  publicKey: z.string(),
  userId: Uuid,
  ownerEmail: Email,
  ownerName: z.string(),
  createdAt: IsoDateTime,
}).openapi("SshKey");

const GenerateRequest = strict({ name: z.string().min(1) }).openapi("GenerateSshKeyRequest");

const GenerateResponse = strict({
  id: Uuid,
  name: z.string(),
  keyType: SshKeyType,
  fingerprint: z.string(),
  publicKey: z.string(),
  privateKey: z.string().openapi({ description: "Returned once. Not persisted in plaintext." }),
}).openapi("GeneratedSshKey");

const ImportRequest = strict({
  name: z.string().min(1),
  publicKey: z.string(),
}).openapi("ImportSshKeyRequest");

const ImportedKey = strict({
  id: Uuid,
  name: z.string(),
  keyType: SshKeyType,
  fingerprint: z.string(),
  publicKey: z.string(),
  isImported: z.literal(true),
}).openapi("ImportedSshKey");

const SshSignAlgorithm = z
  .enum([
    "ssh-ed25519",
    "ssh-rsa",
    "rsa-sha2-256",
    "rsa-sha2-512",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
  ])
  .openapi("SshSignAlgorithm");

const SignRequest = strict({
  data: z.string().openapi({
    description: "The exact bytes SSH wants signed (a publickey-auth challenge), base64-encoded.",
  }),
  algorithm: SshSignAlgorithm,
  context: strict({
    host: z.string().optional(),
    username: z.string().optional(),
  })
    .optional()
    .openapi({ description: "Recorded in the audit log entry for this signature." }),
}).openapi("SignSshKeyRequest");

const SignResponse = strict({
  signature: z.string().openapi({
    description:
      "Raw signature bytes, base64-encoded — Ed25519/RSA as-is, ECDSA in DER as node produces it.",
  }),
  algorithm: SshSignAlgorithm,
}).openapi("SignSshKeyResponse");

export function registerSshKeyPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/ssh-keys",
    tags: ["SSH keys"],
    summary: "List org SSH keys",
    request: { params: OrgIdParam },
    responses: {
      200: { description: "Keys", content: { "application/json": { schema: z.array(SshKey) } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/ssh-keys",
    tags: ["SSH keys"],
    summary: "Generate a new Ed25519 keypair (private key returned once)",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: GenerateRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Generated",
        content: { "application/json": { schema: GenerateResponse } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/ssh-keys/import",
    tags: ["SSH keys"],
    summary: "Import an existing public key",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: ImportRequest } }, required: true },
    },
    responses: {
      200: { description: "Imported", content: { "application/json": { schema: ImportedKey } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/ssh-keys/{id}/sign",
    tags: ["SSH keys"],
    summary: "Sign an SSH auth challenge with a cloud-held key (the cloud as an SSH agent)",
    description:
      "Signs one publickey-authentication challenge with a server-generated org key whose " +
      "private half never leaves Infrawrench Cloud. Requires the `resources:execute` " +
      "permission — producing an auth signature is the same authority as opening a shell. " +
      "Imported keys cannot sign (only their public half is stored). Every call is audited.",
    request: {
      params: OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) }),
      body: { content: { "application/json": { schema: SignRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Signature",
        content: { "application/json": { schema: SignResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/ssh-keys/{id}",
    tags: ["SSH keys"],
    summary: "Delete an SSH key (owner only)",
    request: {
      params: OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) }),
    },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
    },
  });
}
