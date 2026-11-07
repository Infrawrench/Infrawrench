import {
  createApiClient,
  jsonRestFetch,
  type ApiBody,
  type ApiClient,
  type ApiListItem,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";

/**
 * The Machines API (`api.machines.dev`), typed from
 * https://docs.machines.dev/openapi.json. The plugin's other two calls, app logs
 * and Prometheus on `api.fly.io`, are in no document and go through
 * {@link FlyApi.rest}.
 *
 * The host's HTTP service is used whenever there is one: it is what bastion routing
 * and a custom CA need. App names and Machine and volume ids go into paths as
 * written, with `unencodedSegment`, as they always have.
 */
export const MACHINES_API = "https://api.machines.dev";

export interface FlyApi extends ApiClient<paths> {
  /** A GET the typed client cannot make, with the same transport and error text. */
  rest: <T>(url: string, errorPath: string) => Promise<T>;
}

export function createFlyApi(options: {
  token: string;
  caCert?: string | undefined;
  http?: HttpHostServices | undefined;
}): FlyApi {
  const { token, caCert, http } = options;
  const headers = { Authorization: `Bearer ${token}` };
  const transport = http ? { http, ...(caCert ? { caCert } : {}) } : {};
  return {
    ...createApiClient<paths>({
      vendor: "Fly",
      baseUrl: MACHINES_API,
      headers,
      encodeQuery: encodeURIComponent,
      ...transport,
    }),
    rest: (url, errorPath) =>
      jsonRestFetch({ vendor: "Fly", url, errorPath, headers, ...transport }),
  };
}

/** An operation's JSON body, by its `operationId`. */
export type FlyBody<Op extends keyof operations> = ApiBody<operations[Op]>;

export type FlyPlatformRegion = ApiListItem<operations["Platform_regions_get"], "regions">;

/** `created_at` is not in the document; the mapper has always read it when present. */
export type FlyApp = ApiResponse<operations["Apps_show"]> & { created_at?: string };

export type FlyMachine = ApiResponse<operations["Machines_show"]>;
export type FlyMachineConfig = NonNullable<FlyMachine["config"]>;
export type FlyMachineEvent = ApiListItem<operations["Machines_list_events"], null>;

export type FlyVolume = ApiResponse<operations["Volumes_get_by_id"]>;
export type FlyVolumeSnapshot = ApiListItem<operations["Volumes_list_snapshots"], null>;

/**
 * Both the list shape (`CertificateSummary`) and the detail shape
 * (`CertificateDetail`), since one mapper reads either. `id` is not in the document.
 */
export type FlyCertificate = ApiListItem<operations["App_Certificates_list"], "certificates"> &
  ApiResponse<operations["App_Certificates_show"]> & { id?: string };

/** The list route's answer. The document has no bare array; the plugin has always taken one. */
export type FlyCertificateList =
  ApiResponse<operations["App_Certificates_list"]> | FlyCertificate[];

export type FlyIpAssignment = ApiListItem<operations["App_IPAssignments_list"], "ips">;
export type FlyAppSecret = ApiResponse<operations["Secret_get"]>;

/** Both the list shape (`PostgresClusterSummary`) and the detail shape (`PostgresCluster`). */
export type FlyPostgresCluster = ApiListItem<operations["Postgres_list"], "data"> &
  ApiResponse<operations["Postgres_show"]>["data"];
export type FlyPostgresBackup = ApiListItem<operations["Postgres_backups_list"], "data">;
export type FlyPostgresDatabase = ApiListItem<operations["Postgres_databases_list"], "data">;
export type FlyPostgresUser = ApiListItem<operations["Postgres_users_list"], "data">;
