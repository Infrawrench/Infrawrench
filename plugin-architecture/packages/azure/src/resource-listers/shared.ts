export interface ListerContext {
  get<T>(url: string): Promise<T>;
  post<T>(url: string, body: unknown): Promise<T>;
  put<T>(url: string, body: unknown): Promise<T>;
  del(url: string): Promise<void>;
  id(accountId: string, typeId: string, externalId: string): string;
  now(): string;
  subscriptionId: string;
}

export const ARM = "https://management.azure.com";

/** Helper to extract resource group name from a full Azure resource ID */
export function extractResourceGroup(azureId: string): string {
  const match = azureId.match(/resourceGroups\/([^/]+)/i);
  return match?.[1] ?? "";
}

/** Helper to extract a name from a full Azure resource ID */
export function extractName(azureId: string): string {
  return azureId.split("/").pop() ?? "";
}

/**
 * The `properties` bag of a nested ARM object, e.g. one entry of
 * `frontendIPConfigurations`.
 */
export function propsOf(node: unknown): Record<string, unknown> | undefined {
  return (node as Record<string, unknown> | undefined)?.["properties"] as
    | Record<string, unknown>
    | undefined;
}

/**
 * The `id` of a nested ARM reference (`{ publicIPAddress: { id } }`), or "" when
 * the reference is absent.
 */
export function refId(parent: Record<string, unknown> | undefined, key: string): string {
  const ref = parent?.[key] as Record<string, unknown> | undefined;
  return String(ref?.["id"] ?? "");
}

/**
 * `rg/vnet/subnet` — the composite `azure-subnet` resources carry as their
 * external id. Returns "" for anything that isn't a subnet ARM id, so a
 * half-built key never reaches the dependency graph.
 */
export function subnetRef(subnetId: string): string {
  const match = subnetId.match(
    /resourceGroups\/([^/]+)\/providers\/Microsoft\.Network\/virtualNetworks\/([^/]+)\/subnets\/([^/]+)/i,
  );
  if (!match) return "";
  return `${match[1]}/${match[2]}/${match[3]}`;
}

/** The vault name inside a Key Vault URI (`https://kv.vault.azure.net/keys/k/v`). */
export function extractVaultName(uri: string): string {
  return uri.match(/^https:\/\/([^./]+)\.vault\.azure\.net/i)?.[1] ?? "";
}

/**
 * The registry host in an App Service `linuxFxVersion` (`DOCKER|host/image:tag`).
 * Only hosts that look like a registry (they contain a dot) are returned —
 * `NODE|20-lts` and bare Docker Hub images name no registry resource.
 */
export function registryHost(fxVersion: string): string {
  const image = fxVersion.includes("|") ? (fxVersion.split("|")[1] ?? "") : fxVersion;
  const host = image.split("/")[0] ?? "";
  return host.includes(".") ? host : "";
}

/** Bare names of the user-assigned managed identities attached to an ARM resource. */
export function userAssignedIdentityNames(resource: Record<string, unknown>): string[] {
  const identity = resource["identity"] as Record<string, unknown> | undefined;
  const assigned = identity?.["userAssignedIdentities"] as Record<string, unknown> | undefined;
  return Object.keys(assigned ?? {}).map((id) => extractName(id));
}

/**
 * Dedupe, drop blanks and comma-join. Field values are scalars, and the
 * dependency graph splits a comma-joined value into one edge per element.
 */
export function joinRefs(values: Array<string | undefined | null>): string {
  return [...new Set(values.filter((v): v is string => Boolean(v)))].join(", ");
}
