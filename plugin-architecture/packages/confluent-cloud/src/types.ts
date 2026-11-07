import type { components } from "./api-types.management.gen.js";

/**
 * The Confluent Cloud objects this plugin reads, by their schemas in the published
 * document. Responses are read through these rather than as they come: the document's
 * `allOf` arms that only list `required` fields generate `Record<string, never>`, so a
 * response's own fields type as `never` while it stays assignable to its schema.
 */
type Schemas = components["schemas"];

export type CcOrganization = Schemas["org.v2.Organization"];
export type CcEnvironment = Schemas["org.v2.Environment"];
export type CcKafkaCluster = Schemas["cmk.v2.Cluster"];
export type CcConnectorExpanded = Schemas["connect.v1.ConnectorExpansion"];
export type CcComputePool = Schemas["fcpm.v2.ComputePool"];
export type CcFlinkRegion = Schemas["fcpm.v2.Region"];
export type CcKsqlCluster = Schemas["ksqldbcm.v2.Cluster"];
export type CcSchemaRegistry = Schemas["srcm.v3.Cluster"];
export type CcServiceAccount = Schemas["iam.v2.ServiceAccount"];
export type CcApiKey = Schemas["iam.v2.ApiKey"];
export type CcNetwork = Schemas["networking.v1.Network"];

/**
 * What a connection's mapper reads, whichever of the four kinds it is: peerings,
 * transit gateway attachments and private link accesses have a `cloud` object and a
 * `network`, and private link attachments a `cloud` string and a `region`.
 */
export interface CcConnection {
  id?: string;
  metadata?: { created_at?: string };
  spec?: {
    display_name?: string;
    cloud?: string | { kind?: string };
    region?: string;
    environment?: { id?: string };
    network?: { id?: string };
  };
  status?: { phase?: string; error_message?: string };
}

/** `key_name` is in no variant of the document's `key`, and is read anyway. */
export type CcByokKey = Schemas["byok.v1.Key"] & {
  key?: { key_arn?: string; key_id?: string; key_name?: string };
};

/**
 * One Billing Costs line item. Organizations created before 2024-05-15 get
 * the legacy shape, which carries `environment` at the top level and, per
 * Confluent's community forum, may omit `amount` and `discount_amount`; both
 * shapes are read.
 */
export type CcCost = Omit<Schemas["billing.v1.Cost"], "resource"> & {
  environment?: { id?: string };
  resource?: Omit<Schemas["billing.v1.Resource"], "environment"> & {
    environment?: { id?: string } | string | null;
  };
};
