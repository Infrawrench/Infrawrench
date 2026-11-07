import {
  createApiClient,
  withPagination,
  type ApiClient,
  type ApiResponse,
  type HttpHostServices,
  type PaginatedApiClient,
} from "@infrawrench/plugin-base";
import type { operations as cloudOperations, paths as cloudPaths } from "./api-types.cloud.gen.js";
import type {
  operations as storageBoxOperations,
  paths as storageBoxPaths,
} from "./api-types.hetzner.gen.js";

type Paging = "page" | "per_page";

/** The Cloud API (`api.hetzner.cloud/v1`). */
export type CloudApi = PaginatedApiClient<cloudPaths, Paging>;
/** The Hetzner API (`api.hetzner.com/v1`), which hosts Storage Boxes. */
export type StorageBoxApi = PaginatedApiClient<storageBoxPaths, Paging>;

/** A Cloud API operation's response, by its `operationId`. */
export type CloudResponse<Op extends keyof cloudOperations> = ApiResponse<cloudOperations[Op]>;
/** A Hetzner API operation's response, by its `operationId`. */
export type StorageBoxResponse<Op extends keyof storageBoxOperations> = ApiResponse<
  storageBoxOperations[Op]
>;

function paged<P>(client: ApiClient<P>) {
  return withPagination(client, {
    pageParam: "page",
    sizeParam: "per_page",
    pageSize: 50,
    total: (page: { meta?: { pagination?: { total_entries?: number | null } } }) =>
      page.meta?.pagination?.total_entries,
  });
}

/** Both APIs take the same project-scoped token. */
export function createHetznerApis(options: {
  token: string;
  caCert?: string | undefined;
  http?: HttpHostServices | undefined;
}): { cloud: CloudApi; storageBoxes: StorageBoxApi } {
  const { token, caCert, http } = options;
  const shared = {
    vendor: "Hetzner",
    headers: { Authorization: `Bearer ${token}` },
    http,
    caCert,
  };
  return {
    cloud: paged(
      createApiClient<cloudPaths>({ ...shared, baseUrl: "https://api.hetzner.cloud/v1" }),
    ),
    storageBoxes: paged(
      createApiClient<storageBoxPaths>({ ...shared, baseUrl: "https://api.hetzner.com/v1" }),
    ),
  };
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
