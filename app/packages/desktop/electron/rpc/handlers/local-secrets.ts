/**
 * Local accounts' credentials and the other secrets the renderer stores
 * encrypted: the two groups whose answers are decrypted plaintext.
 */
import { Effect, Layer } from "effect";
import { LocalCredentialRpcs } from "../../../shared/rpc/groups/local-credentials";
import { LocalSecretRpcs } from "../../../shared/rpc/groups/local-secrets";
import { LocalCredentials } from "../../local-credentials";
import { LocalSecrets } from "../../local-secrets";

export const LocalCredentialHandlers = LocalCredentialRpcs.toLayer(
  Effect.gen(function* () {
    const credentials = yield* LocalCredentials;
    return LocalCredentialRpcs.of({
      LocalAccountCredentials: ({ accountId, refresh }) =>
        credentials.read(accountId, refresh !== false),
      LocalAccountSaveCredentials: ({ accountId, credentials: incoming }) =>
        credentials.save(accountId, incoming),
      LocalAccountCreate: (account) => credentials.create(account),
    });
  }),
).pipe(Layer.provide(LocalCredentials.layer));

export const LocalSecretHandlers = LocalSecretRpcs.toLayer(
  Effect.gen(function* () {
    const secrets = yield* LocalSecrets;
    return LocalSecretRpcs.of({
      LocalSshKeyPrivateKey: ({ keyId }) => secrets.sshPrivateKey(keyId),
      LocalSshKeyPublicKey: ({ keyId }) => secrets.sshPublicKey(keyId),
      LocalSshKeyEnsureAgentKey: () => secrets.ensureAgentKey,
      LocalSshKeySave: ({ keyId, name, privateKey }) => secrets.saveSshKey(keyId, name, privateKey),
      LocalTunnelConfigKeyDecrypt: ({ tunnelConfigId, ciphertext, iv }) =>
        secrets.decryptTunnelConfigKey(tunnelConfigId, { ciphertext, iv }),
      LocalTunnelConfigKeyEncrypt: ({ tunnelConfigId, privateKey }) =>
        secrets.encryptTunnelConfigKey(tunnelConfigId, privateKey),
      LocalSecretFieldDecrypt: ({ resourceId, fieldKey, ciphertext, iv }) =>
        secrets.decryptSecretField(resourceId, fieldKey, { ciphertext, iv }),
      LocalSecretFieldEncrypt: ({ resourceId, fieldKey, plaintext }) =>
        secrets.encryptSecretField(resourceId, fieldKey, plaintext),
    });
  }),
).pipe(Layer.provide(LocalSecrets.layer));
