/**
 * The request surface the per-product modules (DNS, certificates, Storage
 * Boxes) need from `HetznerClient`. Bound by the client so every call keeps
 * its token, CA-cert routing and pagination.
 */
export interface HetznerApi {
  /** One request against the Cloud API (`api.hetzner.cloud/v1`). */
  fetch<T>(path: string, init?: RequestInit): Promise<T>;
  /** Every page of a Cloud API list endpoint. */
  fetchAll<T>(path: string, rootKey: string): Promise<T[]>;
  /** One request against the Hetzner API (`api.hetzner.com/v1`). */
  fetchHetzner<T>(path: string, init?: RequestInit): Promise<T>;
  /** Every page of a Hetzner API list endpoint. */
  fetchAllHetzner<T>(path: string, rootKey: string): Promise<T[]>;
}

/** Numeric id at the end of a host resource id (`acct:type:123`). */
export function trailingId(resourceId: string): string {
  const id = resourceId.split(":").pop();
  if (!id) throw new Error(`Cannot parse resource ID "${resourceId}"`);
  return id;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `"true"`/`"false"` form values to booleans; anything else is "unchanged". */
export function formBool(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}
