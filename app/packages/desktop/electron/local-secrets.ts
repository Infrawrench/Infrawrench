/**
 * The renderer's stored secrets (`LocalSecretRpcs`), as an Effect service:
 * SSH keys, tunnel configs' private keys and secret resource fields, each
 * encrypted with the master key under an AAD bound to its row and field.
 */
import crypto from "node:crypto";
import { Context, Effect, Layer } from "effect";
import { generateEd25519OpenSshKeyPair } from "@infrawrench/ssh-tunnel-core";
import { errorMessage } from "../shared/rpc/errors";
import {
  LocalSecretError,
  type AgentSshKey,
  type EncryptedValue,
} from "../shared/rpc/groups/local-secrets";
import { getSqlite, persist } from "./db";
import { buildAad, decryptValue, encryptValue, getEncryptionKey } from "./main-utils";

const AGENT_SSH_KEY_NAME = "infrawrench-agent";

const sshKeyAad = (keyId: string) => buildAad("sshKey", keyId, "privateKey");

/** The first row `sql` answers for `params`, or null. */
async function firstRow(sql: string, params: string[]) {
  const db = await getSqlite();
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    return stmt.step() ? stmt.getAsObject() : null;
  } finally {
    stmt.free();
  }
}

async function readSshPrivateKey(keyId: string, notFound: string): Promise<string> {
  const row = await firstRow("SELECT encrypted_key, key_iv FROM ssh_keys WHERE id = ? LIMIT 1", [
    keyId,
  ]);
  if (!row) throw new Error(notFound);
  return decryptValue(
    String(row["encrypted_key"] ?? ""),
    String(row["key_iv"] ?? ""),
    getEncryptionKey(),
    sshKeyAad(keyId),
  );
}

async function getSsh2Utils(): Promise<typeof import("ssh2").utils> {
  const mod = await import("ssh2");
  const utils = mod.utils ?? mod.default?.utils;
  if (!utils) throw new Error("Could not load ssh2 key utilities");
  return utils;
}

/** `<type> <base64>` for a private key; desktop keys store only the private half. */
async function derivePublicKey(privateKey: string): Promise<string> {
  const parsed = (await getSsh2Utils()).parseKey(privateKey);
  if (parsed instanceof Error) {
    throw new Error(`Could not derive public key for SSH key: ${parsed.message}`);
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  return `${key.type} ${key.getPublicSSH().toString("base64")}`;
}

async function insertSshKey(keyId: string, name: string, privateKey: string): Promise<void> {
  const { ciphertext, iv } = encryptValue(privateKey, getEncryptionKey(), sshKeyAad(keyId));
  const db = await getSqlite();
  db.run("INSERT INTO ssh_keys (id, name, encrypted_key, key_iv) VALUES (?, ?, ?, ?)", [
    keyId,
    name,
    ciphertext,
    iv,
  ]);
  persist();
}

async function ensureAgentKey(): Promise<AgentSshKey> {
  const existing = await firstRow("SELECT id FROM ssh_keys WHERE name = ? LIMIT 1", [
    AGENT_SSH_KEY_NAME,
  ]);
  if (existing) {
    const keyId = String(existing["id"] ?? "");
    const privateKey = await readSshPrivateKey(keyId, "Agent SSH key not found");
    return {
      id: keyId,
      name: AGENT_SSH_KEY_NAME,
      publicKey: `${await derivePublicKey(privateKey)} ${AGENT_SSH_KEY_NAME}`,
    };
  }
  const { publicKey, privateKey } = await generateEd25519OpenSshKeyPair(AGENT_SSH_KEY_NAME);
  const keyId = crypto.randomUUID();
  await insertSshKey(keyId, AGENT_SSH_KEY_NAME, privateKey);
  return { id: keyId, name: AGENT_SSH_KEY_NAME, publicKey };
}

const tunnelConfigAad = (tunnelConfigId: string) =>
  buildAad("sshTunnelConfig", tunnelConfigId, "privateKey");
const secretFieldAad = (resourceId: string, fieldKey: string) =>
  buildAad("secretField", `${resourceId}:${fieldKey}`, "value");

const toSecretError = (cause: unknown) => new LocalSecretError({ message: errorMessage(cause) });
const attempt = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: toSecretError });
const attemptSync = <A>(f: () => A) => Effect.try({ try: f, catch: toSecretError });

export class LocalSecrets extends Context.Service<
  LocalSecrets,
  {
    readonly sshPrivateKey: (keyId: string) => Effect.Effect<string, LocalSecretError>;
    readonly sshPublicKey: (keyId: string) => Effect.Effect<string, LocalSecretError>;
    readonly ensureAgentKey: Effect.Effect<AgentSshKey, LocalSecretError>;
    readonly saveSshKey: (
      keyId: string,
      name: string,
      privateKey: string,
    ) => Effect.Effect<void, LocalSecretError>;
    readonly decryptTunnelConfigKey: (
      tunnelConfigId: string,
      value: EncryptedValue,
    ) => Effect.Effect<string, LocalSecretError>;
    readonly encryptTunnelConfigKey: (
      tunnelConfigId: string,
      privateKey: string,
    ) => Effect.Effect<EncryptedValue, LocalSecretError>;
    readonly decryptSecretField: (
      resourceId: string,
      fieldKey: string,
      value: EncryptedValue,
    ) => Effect.Effect<string, LocalSecretError>;
    readonly encryptSecretField: (
      resourceId: string,
      fieldKey: string,
      plaintext: string,
    ) => Effect.Effect<EncryptedValue, LocalSecretError>;
  }
>()("infrawrench/desktop/LocalSecrets") {
  static readonly layer = Layer.succeed(LocalSecrets)(
    LocalSecrets.of({
      sshPrivateKey: (keyId) => attempt(() => readSshPrivateKey(keyId, "SSH key not found")),
      sshPublicKey: (keyId) =>
        attempt(async () => derivePublicKey(await readSshPrivateKey(keyId, "SSH key not found"))),
      ensureAgentKey: attempt(ensureAgentKey),
      saveSshKey: (keyId, name, privateKey) => attempt(() => insertSshKey(keyId, name, privateKey)),
      decryptTunnelConfigKey: (tunnelConfigId, { ciphertext, iv }) =>
        attemptSync(() =>
          decryptValue(ciphertext, iv, getEncryptionKey(), tunnelConfigAad(tunnelConfigId)),
        ),
      encryptTunnelConfigKey: (tunnelConfigId, privateKey) =>
        attemptSync(() =>
          encryptValue(privateKey, getEncryptionKey(), tunnelConfigAad(tunnelConfigId)),
        ),
      decryptSecretField: (resourceId, fieldKey, { ciphertext, iv }) =>
        attemptSync(() =>
          decryptValue(ciphertext, iv, getEncryptionKey(), secretFieldAad(resourceId, fieldKey)),
        ),
      encryptSecretField: (resourceId, fieldKey, plaintext) =>
        attemptSync(() =>
          encryptValue(plaintext, getEncryptionKey(), secretFieldAad(resourceId, fieldKey)),
        ),
    }),
  );
}
