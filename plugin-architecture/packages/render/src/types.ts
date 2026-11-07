import type { ApiListItem, ApiResponse } from "@infrawrench/plugin-base";
import type { components, operations } from "./api-types.gen.js";

/** The Render API payloads this plugin reads, named from the OpenAPI document. */

type Schemas = components["schemas"];

type KeysOf<U> = U extends U ? keyof U : never;

/**
 * Every field of every member of a union, each optional. Render's service details
 * and build details are unions with no field to tell them apart, and what reads
 * them only cares whether a field is there.
 */
type Flat<U> = {
  [K in KeysOf<U>]?: U extends U ? (K extends keyof U ? Exclude<U[K], undefined> : never) : never;
};

type ServiceDetails = Flat<Schemas["service"]["serviceDetails"]>;

type RenderServiceDetails = Omit<ServiceDetails, "envSpecificDetails"> & {
  envSpecificDetails?: Flat<NonNullable<ServiceDetails["envSpecificDetails"]>>;
  /** Not in the document here, only under `envSpecificDetails`; read as a fallback. */
  preDeployCommand?: string;
};

export type RenderService = Omit<Schemas["service"], "serviceDetails"> & {
  serviceDetails?: RenderServiceDetails;
};

/** What `PATCH /services/{id}` can change, across the service types. */
export type RenderServicePatchDetails = Flat<
  NonNullable<
    NonNullable<
      operations["update-service"]["requestBody"]
    >["content"]["application/json"]["serviceDetails"]
  >
>;

export type RenderOwner = Schemas["owner"];
export type RenderIpAllow = Schemas["cidrBlockAndDescription"];
export type RenderDeploy = Schemas["deploy"];
export type RenderEnvVar = Schemas["envVar"];
export type RenderCustomDomain = Schemas["customDomain"];
export type RenderMaintenance = ApiListItem<operations["list-maintenance"], null>;

/** A list row, or the detail answer, which adds the maintenance run. */
export type RenderPostgres = Schemas["postgres"] & {
  maintenance?: Schemas["postgresDetail"]["maintenance"];
};

/** A list row, or the detail answer, which adds the maintenance run and has no dashboard link. */
export type RenderKeyValue = Omit<Schemas["keyValue"], "dashboardUrl"> & {
  dashboardUrl?: string;
  maintenance?: Schemas["keyValueDetail"]["maintenance"];
};

export type RenderDisk = ApiResponse<operations["retrieve-disk"]>;
export type RenderDiskSnapshot = Schemas["diskSnapshot"];
export type RenderJob = ApiResponse<operations["retrieve-job"]>;

/** A list row, or the single-group answer, which adds the variables and secret files. */
export type RenderEnvGroup = Schemas["envGroupMeta"] &
  Partial<Pick<Schemas["envGroup"], "envVars" | "secretFiles">>;

export type RenderBlueprint = Schemas["blueprintWithCursor"]["blueprint"];
export type RenderBlueprintSync = Schemas["syncWithCursor"]["sync"];
export type RenderProject = Schemas["project"];
export type RenderEnvironment = Schemas["environment"];
export type RenderMetricSeries = ApiResponse<operations["get-cpu"]>[number];
export type RenderLogLine = NonNullable<ApiResponse<operations["list-logs"]>["logs"]>[number];

export type RenderServiceEvent = Schemas["serviceEventWithCursor"]["event"];
export type RenderInstance = Schemas["serviceInstance"];
export type RenderPostgresUser = ApiListItem<operations["list-postgres-users"], null>;
export type RenderPostgresRecovery = ApiResponse<operations["retrieve-postgres-recovery-info"]>;
export type RenderPostgresExport = ApiListItem<operations["list-postgres-export"], null>;
export type RenderTeamMember = Schemas["teamMembers"][number];
