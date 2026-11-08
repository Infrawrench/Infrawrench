/**
 * Secrets the renderer stores in the local database, encrypted and decrypted
 * by the main process under an AAD bound to each row and field
 * (`shared/rpc/groups/local-secrets.ts`); the renderer never holds the key.
 */
import type { AgentSshKey, EncryptedValue } from "../../shared/rpc/groups/local-secrets";
import { DesktopRpcClient, runRpc } from "./rpc/client";

/** A stored SSH key's private half (`ssh_keys`). */
export function getLocalSshPrivateKey(keyId: string): Promise<string> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.LocalSshKeyPrivateKey({ keyId })));
}

/** A stored SSH key's OpenSSH public key, derived from its private half. */
export function getLocalSshPublicKey(keyId: string): Promise<string> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.LocalSshKeyPublicKey({ keyId })));
}

/** The `infrawrench-agent` key agent VMs trust, generated on first use. */
export function ensureAgentSshKey(): Promise<AgentSshKey> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.LocalSshKeyEnsureAgentKey()));
}

/** Store a private key under `keyId`. */
export function saveLocalSshKey(key: {
  keyId: string;
  name: string;
  privateKey: string;
}): Promise<void> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.LocalSshKeySave(key)));
}

/** An SSH tunnel config's private key, from the ciphertext its row holds. */
export function decryptTunnelConfigKey(
  tunnelConfigId: string,
  { ciphertext, iv }: EncryptedValue,
): Promise<string> {
  return runRpc(
    DesktopRpcClient.use((rpc) =>
      rpc.LocalTunnelConfigKeyDecrypt({ tunnelConfigId, ciphertext, iv }),
    ),
  );
}

/** Encrypt an SSH tunnel config's private key for its row. */
export function encryptTunnelConfigKey(
  tunnelConfigId: string,
  privateKey: string,
): Promise<EncryptedValue> {
  return runRpc(
    DesktopRpcClient.use((rpc) => rpc.LocalTunnelConfigKeyEncrypt({ tunnelConfigId, privateKey })),
  );
}

/** A secret field's plaintext, bound to `(resourceId, fieldKey)`. */
export function decryptSecretField(
  resourceId: string,
  fieldKey: string,
  { ciphertext, iv }: EncryptedValue,
): Promise<string> {
  return runRpc(
    DesktopRpcClient.use((rpc) =>
      rpc.LocalSecretFieldDecrypt({ resourceId, fieldKey, ciphertext, iv }),
    ),
  );
}

/** Encrypt a secret field's plaintext for `(resourceId, fieldKey)`. */
export function encryptSecretField(
  resourceId: string,
  fieldKey: string,
  plaintext: string,
): Promise<EncryptedValue> {
  return runRpc(
    DesktopRpcClient.use((rpc) => rpc.LocalSecretFieldEncrypt({ resourceId, fieldKey, plaintext })),
  );
}
