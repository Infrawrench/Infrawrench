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
