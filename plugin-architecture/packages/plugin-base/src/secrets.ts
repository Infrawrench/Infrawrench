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

export type SecretResolution = LiteralSecretResolution | OutputRefSecretResolution;

/** Stored per secret/association field per resource instance */
export interface SecretFieldState {
  fieldKey: string;
  resolution: SecretResolution;
}
