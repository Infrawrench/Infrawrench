/**
 * Org SSH keys: `/api/org/:orgId/ssh-keys`, the handlers.
 *
 * Private halves are encrypted at rest with an AAD bound to the row id and are
 * returned exactly once, by `generate`. `sign` is the cloud acting as an SSH
 * agent: the key material moves nowhere, only signatures do, and every call is
 * audited, refusals included.
 */
import crypto from "node:crypto";
import { Effect, Predicate, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { eq, and } from "drizzle-orm";
import {
  computeSshPublicKeyFingerprint,
  generateEd25519OpenSshKeyPair,
  isSshSignAlgorithm,
  signSshData,
} from "@infrawrench/ssh-tunnel-core";
import { hasPermission } from "@infrawrench/server-core/permissions";
import {
  badRequest,
  BadRequest,
  GeneratedSshKey,
  ImportedSshKey,
  NotFound,
  notFound,
  ok,
  SignSshKeyResponse,
  SshKey,
  SshKeysApi,
} from "@infrawrench/api-contract";
import { db } from "../../../db/client";
import { sshKeys, users } from "../../../db/schema";
import { encrypt, decrypt, buildAad } from "../../../services/encryption";
import { validateSshPublicKey } from "../../../services/ssh-keys";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { fieldsOf, readJson } from "../../request-body";
import { fireAndForget, legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

async function listSshKeys(organizationId: string) {
  const rows = await db
    .select({
      id: sshKeys.id,
      name: sshKeys.name,
      keyType: sshKeys.keyType,
      isImported: sshKeys.isImported,
      fingerprint: sshKeys.fingerprint,
      encryptedPublicKey: sshKeys.encryptedPublicKey,
      publicKeyIv: sshKeys.publicKeyIv,
      userId: sshKeys.userId,
      userEmail: users.email,
      userDisplayName: users.displayName,
      createdAt: sshKeys.createdAt,
    })
    .from(sshKeys)
    .innerJoin(users, eq(sshKeys.userId, users.id))
    .where(eq(sshKeys.organizationId, organizationId))
    .orderBy(sshKeys.createdAt);

  return Promise.all(
    rows.map(async (row) => {
      const publicKey = await decrypt(
        row.encryptedPublicKey,
        row.publicKeyIv,
        buildAad("sshKey", row.id, "publicKey"),
      );
      return {
        id: row.id,
        name: row.name,
        keyType: row.keyType,
        isImported: row.isImported,
        fingerprint: row.fingerprint,
        publicKey,
        userId: row.userId,
        ownerEmail: row.userEmail,
        ownerName: row.userDisplayName ?? row.userEmail,
        createdAt: row.createdAt.toISOString(),
      };
    }),
  );
}

/** Generate an Ed25519 keypair; the private key is returned to the caller exactly once. */
async function generateSshKey(organizationId: string, userId: string, name: string) {
  const { publicKey: sshPublicKey, privateKey: privateKeyOpenSsh } =
    await generateEd25519OpenSshKeyPair(name);
  const id = crypto.randomUUID();
  const fingerprint = computeSshPublicKeyFingerprint(sshPublicKey);
  // AAD binds the ciphertext to this row id.
  const encPub = await encrypt(sshPublicKey, buildAad("sshKey", id, "publicKey"));
  const encPriv = await encrypt(privateKeyOpenSsh, buildAad("sshKey", id, "privateKey"));
  await db.insert(sshKeys).values({
    id,
    organizationId,
    userId,
    name,
    encryptedPublicKey: encPub.ciphertext,
    publicKeyIv: encPub.iv,
    encryptedPrivateKey: encPriv.ciphertext,
    privateKeyIv: encPriv.iv,
    keyType: "ssh-ed25519",
    isImported: false,
    fingerprint,
  });
  return {
    id,
    name,
    keyType: "ssh-ed25519",
    fingerprint,
    publicKey: sshPublicKey,
    privateKey: privateKeyOpenSsh,
  };
}

/** Store only the public key; the user retains the private key. */
async function importSshKey(
  organizationId: string,
  userId: string,
  name: string,
  keyType: string,
  publicKey: string,
) {
  const fingerprint = computeSshPublicKeyFingerprint(publicKey);
  const id = crypto.randomUUID();
  const encPub = await encrypt(publicKey, buildAad("sshKey", id, "publicKey"));
  await db.insert(sshKeys).values({
    id,
    organizationId,
    userId,
    name,
    encryptedPublicKey: encPub.ciphertext,
    publicKeyIv: encPub.iv,
    keyType,
    isImported: true,
    fingerprint,
  });
  return { id, name, keyType, fingerprint, publicKey, isImported: true };
}

// A userauth blob is a session id plus the request fields: a few hundred
// bytes. The cap only exists so the endpoint cannot be fed arbitrary payloads.
const MAX_SIGN_DATA_BYTES = 16 * 1024;

const validatedPublicKey = (raw: string) =>
  Effect.try({
    try: () => validateSshPublicKey(raw),
    catch: (e) =>
      new BadRequest({ error: e instanceof Error ? e.message : "Invalid SSH public key" }),
  });

const SshKeysHandlers = HttpApiBuilder.group(SshKeysApi, "sshKeys", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const keys = yield* legacy(() => listSshKeys(organizationId));
        return yield* respond(Schema.Array(SshKey))(keys);
      }),
    )
    .handleRaw("generate", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const { name } = yield* fieldsOf(yield* readJson(request));
        if (!Predicate.isString(name) || !name.trim()) return yield* badRequest("Name is required");
        const trimmed = name.trim();
        const generated = yield* legacy(() =>
          generateSshKey(organizationId, session.userId, trimmed),
        );
        return yield* respond(GeneratedSshKey)(generated);
      }),
    )
    .handleRaw("import", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const { name, publicKey: rawPublicKey } = yield* fieldsOf(yield* readJson(request));
        if (!Predicate.isString(name) || !name.trim()) return yield* badRequest("Name is required");
        if (!Predicate.isString(rawPublicKey) || !rawPublicKey.trim()) {
          return yield* badRequest("Public key is required");
        }
        const { keyType, publicKey } = yield* validatedPublicKey(rawPublicKey);
        const trimmed = name.trim();
        const imported = yield* legacy(() =>
          importSshKey(organizationId, session.userId, trimmed, keyType, publicKey),
        );
        return yield* respond(ImportedSshKey)(imported);
      }),
    )
    .handleRaw("sign", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const { userId } = session;
        const id = params.id;
        const { data, algorithm, context } = yield* fieldsOf(yield* readJson(request));
        const host = Predicate.isObject(context) ? context["host"] : undefined;
        const username = Predicate.isObject(context) ? context["username"] : undefined;

        const auditBase = { organizationId, userId, entityType: "ssh-key", entityId: id };
        const auditMeta = {
          sshKeyId: id,
          source: "remote-agent",
          ...(Predicate.isString(host) ? { sshHost: host.slice(0, 256) } : {}),
          ...(Predicate.isString(username) ? { sshUsername: username.slice(0, 256) } : {}),
        };
        /** Refuse, recording why: a failed signature is as interesting to an auditor as one made. */
        const refuse = <E>(error: E, failureReason: string) =>
          Effect.gen(function* () {
            yield* fireAndForget(() =>
              logAudit({
                ...auditBase,
                action: "ssh.agent.sign_failed",
                metadata: { ...auditMeta, failureReason },
              }),
            );
            return yield* Effect.fail(error);
          });
        const refuse400 = (error: string, failureReason: string) =>
          refuse(new BadRequest({ error }), failureReason);

        if (!data || !Predicate.isString(data)) {
          return yield* refuse400("data (base64) is required", "missing_data");
        }
        if (!algorithm || !Predicate.isString(algorithm) || !isSshSignAlgorithm(algorithm)) {
          return yield* refuse400(
            "algorithm must be an SSH signature format identifier",
            "bad_algorithm",
          );
        }
        const payload = Buffer.from(data, "base64");
        if (payload.length === 0 || payload.length > MAX_SIGN_DATA_BYTES) {
          return yield* refuse400("data must decode to between 1 byte and 16 KiB", "bad_data_size");
        }

        const [key] = yield* legacy(() =>
          db
            .select()
            .from(sshKeys)
            .where(and(eq(sshKeys.id, id), eq(sshKeys.organizationId, organizationId))),
        );
        if (!key) return yield* refuse(new NotFound({ error: "SSH key not found" }), "not_found");
        const { encryptedPrivateKey, privateKeyIv } = key;
        if (!encryptedPrivateKey || !privateKeyIv) {
          return yield* refuse400(
            "This key was imported; its private half is not held by Infrawrench Cloud, so the cloud cannot sign with it",
            "no_private_key",
          );
        }

        const privateKey = yield* legacy(() =>
          decrypt(encryptedPrivateKey, privateKeyIv, buildAad("sshKey", key.id, "privateKey")),
        );

        const signed = yield* Effect.result(
          Effect.try({
            try: () => signSshData(privateKey, payload, algorithm),
            catch: (e) => (e instanceof Error ? e.message : "Signing failed"),
          }),
        );
        if (signed._tag === "Failure") {
          return yield* refuse400(signed.failure, `sign_error:${signed.failure}`);
        }

        yield* fireAndForget(() =>
          logAudit({
            ...auditBase,
            action: "ssh.agent.sign",
            metadata: { ...auditMeta, keyType: key.keyType, signatureFormat: algorithm },
          }),
        );
        return yield* respond(SignSshKeyResponse)({
          signature: signed.success.toString("base64"),
          algorithm,
        });
      }),
    )
    // Owners may delete their own keys; team:role:write may delete any key in
    // the org (offboarding, revoking compromised keys). 404 covers wrong id,
    // wrong org, or a non-admin targeting someone else's key.
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session, permissions } = yield* OrgPrincipal;
        const canManageAll = hasPermission(permissions, "team:role:write");
        const whereClause = canManageAll
          ? and(eq(sshKeys.id, params.id), eq(sshKeys.organizationId, organizationId))
          : and(
              eq(sshKeys.id, params.id),
              eq(sshKeys.organizationId, organizationId),
              eq(sshKeys.userId, session.userId),
            );
        const result = yield* legacy(() =>
          db.delete(sshKeys).where(whereClause).returning({ id: sshKeys.id }),
        );
        if (result.length === 0) return yield* notFound("SSH key not found");
        return ok;
      }),
    ),
);

export const sshKeysDomain = makeDomain("sshKeys", SshKeysApi, SshKeysHandlers);
