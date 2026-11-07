import type { CapellaResponse, CapellaRow } from "./api.js";
import type { components } from "./api-types.gen.js";

type Schemas = components["schemas"];

/**
 * Every field optional at every depth. The mappers read with `?.`, whatever the
 * document calls required, and are also handed what the plugin has just created,
 * of which it only knows a little.
 */
type Loose<T> = T extends readonly (infer Item)[]
  ? Loose<Item>[]
  : T extends object
    ? { [K in keyof T]?: Loose<T[K]> }
    : T;

type Mapped<Row> = Loose<Row> & { id: string };

export type Audit = Loose<Schemas["CouchbaseAuditData"]>;
export type CpProject = Mapped<CapellaRow<"listProjects">>;
export type CpServiceGroup = Loose<Schemas["ServiceGroup"]>;
export type CpCluster = Mapped<CapellaRow<"listClusters">>;
export type CpClusterStats = Loose<CapellaResponse<"getClusterStats">>;
export type CpAppService = Mapped<CapellaRow<"listAppServices">>;
export type CpBucket = Mapped<CapellaRow<"listBuckets">>;
export type CpCredential = Mapped<CapellaRow<"listDatabaseCredentials">>;
export type CpCidr = Mapped<CapellaRow<"listAllowedCidrs">>;
export type CpBackup = Mapped<CapellaRow<"listClusterBackups">>;
export type CpUser = Mapped<CapellaRow<"listUsers">>;
export type CpApiKey = Mapped<CapellaRow<"listOrganizationAPIKeys">>;
