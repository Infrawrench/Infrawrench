/** The user typed or pasted the value directly — stored AES-256-GCM encrypted */
export interface LiteralSecretResolution {
  kind: "literal";
  encryptedValue: string;
  /** AES-GCM initialisation vector (base64) */
  iv: string;
}

/**
 * The value is sourced from another resource's output at runtime.
 * The host calls the provider plugin's resolveOutput() and caches the result.
 */
export interface OutputRefSecretResolution {
  kind: "output-ref";
  sourcePluginId: string;
  sourceResourceTypeId: string;
  sourceResourceId: string;
  sourceAccountId: string;
  outputKey: string;
  /** Stale-while-revalidate cache — encrypted, same scheme as literal */
  cachedEncryptedValue?: string;
  cachedIv?: string;
  /** ISO timestamp of last successful resolution */
  cachedAt?: string;
}

/**
 * Transient, host-internal kind. A plugin returns this from `createResource` to
 * hand the host plaintext to encrypt + persist. The host upgrades it to a
 * `LiteralSecretResolution` before insert. On read, the host decrypts a stored
 * `LiteralSecretResolution` back to this shape so plugins never see ciphertext.
 * Never written to the database.
 */
export interface PlaintextSecretResolution {
  kind: "plaintext";
  value: string;
}

export type SecretResolution =
  LiteralSecretResolution | OutputRefSecretResolution | PlaintextSecretResolution;

/** Stored per secret/association field per resource instance */
export interface SecretFieldState {
  fieldKey: string;
  resolution: SecretResolution;
}
