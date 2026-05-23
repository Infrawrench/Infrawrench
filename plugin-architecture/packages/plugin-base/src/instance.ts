import type { SecretFieldState } from "./secrets.js";

export interface ResourceInstance {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  /** Which account/credential set this resource belongs to */
  accountId: string;
  displayName: string;
  /** Non-secret field values */
  fields: Record<string, string | number | boolean>;
  /**
   * Resolved output values — populated by the host on demand.
   * Only populated for outputs that have been explicitly requested.
   */
  resolvedOutputs: Record<string, string>;
  /** Secret and association field states, loaded by the host from DB */
  secretStates: SecretFieldState[];
  /** The provider's own ID for this resource (e.g. DO droplet ID) */
  externalId?: string;
  /** ID of the parent resource instance, if this is a child resource */
  parentResourceId?: string;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt?: string;
}

/**
 * A non-fatal warning surfaced by `createResource` when a primary action
 * succeeded but a secondary step failed (e.g. resource created but project
 * assignment failed). The host renders these as toast warnings.
 */
export interface ResourceWarning {
  code: string;
  message: string;
  cause?: unknown;
}

/**
 * Wider response shape from `createResource`. Plugins may return either a
 * bare `ResourceInstance` or a `{ resource, warnings }` envelope when
 * partial success needs to be surfaced. The host normalizes via
 * {@link normalizeResourceCreateResult}.
 */
export interface ResourceCreateResult {
  resource: ResourceInstance;
  warnings: ResourceWarning[];
  /**
   * When set, the host merges these keys into the account's stored
   * credentials and persists the encrypted row before returning the new
   * resource to the user. Used by providers that auto-mint sidecar
   * credentials during creation — e.g. the DigitalOcean plugin mints an
   * account-wide Spaces S3 key on first bucket-create so the user doesn't
   * have to paste one manually. Existing keys are preserved; only the
   * keys present in this map are overwritten.
   */
  credentialUpdates?: Record<string, string>;
}

export type ResourceCreateReturn = ResourceInstance | ResourceCreateResult;

export function normalizeResourceCreateResult(result: ResourceCreateReturn): ResourceCreateResult {
  if ("resource" in result && "warnings" in result) return result;
  return { resource: result, warnings: [] };
}
