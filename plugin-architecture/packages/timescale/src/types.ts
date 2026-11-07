import type { components } from "./api-types.gen.js";

type Schemas = components["schemas"];

export type TgProject = Schemas["Project"];
export type TgReadReplicaSet = Schemas["ReadReplicaSet"];
export type TgService = Schemas["Service"];
export type TgVpc = Schemas["VPC"];
export type TgPeering = Schemas["Peering"];
export type TgExporter = Schemas["Exporter"];
export type TgAllowList = Schemas["AllowList"];
export type TgBackup = Schemas["Backup"];
export type TgMetricSeries = Schemas["MetricSeries"];
export type TgAwsCredentials = Schemas["AWSCredentials"];
export type TgAwsCredentialsUpdate = Schemas["AWSCredentialsUpdate"];
export type TgIamRoleCredentials = Schemas["AWSIAMRoleCredentials"];

/** A replica set being created, which has no size or node count to show yet. */
export type TgPendingReplicaSet = Pick<TgReadReplicaSet, "id" | "name" | "status"> &
  Partial<TgReadReplicaSet>;

type KeysOf<U> = U extends U ? keyof U : never;

/** Every field of every member of a union, each optional, for reading without narrowing first. */
type Flat<U> = { [K in KeysOf<U>]?: U extends U ? (K extends keyof U ? U[K] : never) : never };

/**
 * An exporter's `config` as a read sees it: one shape per exporter type in the
 * document, read here by field since a secret never comes back, whatever the
 * document's `required` says about writing one.
 */
export type TgExporterConfigView = Omit<Flat<TgExporter["config"]>, "credentials"> & {
  credentials?: TgAwsCredentialsUpdate;
};

/** An exporter as `PATCH` is rebuilt from it. */
export type TgExporterView = Omit<Flat<TgExporter>, "config"> & { config?: TgExporterConfigView };
