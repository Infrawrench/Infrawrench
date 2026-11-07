/**
 * Response shapes from Linode API v4, named from the generated types of the
 * published OpenAPI document (`plugingen.json`). Nearly every field is optional
 * there: the API grows fields over time and a missing one must degrade to an empty
 * value, never a crash.
 */

import type { ApiBody, ApiListItem } from "@infrawrench/plugin-base";
import type { LinodeResponse } from "./api.js";
import type { operations } from "./api-types.gen.js";

export type LinodeInstance = LinodeResponse<"post-linode-instance">;
export type LinodeType = ApiListItem<operations["get-linode-types"], "data">;
/**
 * `/volumes/types`, `/nodebalancers/types`, `/lke/types`, `/object-storage/types`, ...
 * Named by the widest of them, which the others are assignable to.
 */
export type LinodeSimpleType = ApiListItem<operations["get-reserved-ip-types"], "data">;
export type LinodePrice = NonNullable<LinodeSimpleType["price"]>;
export type LinodeRegionPrice = NonNullable<LinodeSimpleType["region_prices"]>[number];
export type LinodeDatabaseType = ApiListItem<operations["get-databases-types"], "data">;
export type LinodeVolume = LinodeResponse<"get-volume">;
export type LinodeNodeBalancer = LinodeResponse<"post-node-balancer">;
export type LinodeNodeBalancerConfig = ApiListItem<operations["get-node-balancer-configs"], "data">;
export type LinodeLkeCluster = LinodeResponse<"get-lke-cluster">;
export type LinodeLkePool = LinodeResponse<"get-lke-node-pool">;
export type LinodeBucket = ApiListItem<operations["get-object-storage-buckets"], "data">;
export type LinodeDatabase = LinodeResponse<"get-database-instance">;
export type LinodeFirewall = LinodeResponse<"get-firewall">;
/** A rule as the plugin writes it, which a rule read back is assignable to. */
export type LinodeFirewallRule = NonNullable<
  ApiBody<operations["put-firewall-rules"]>["inbound"]
>[number];
export type LinodeDomain = LinodeResponse<"get-domain">;
export type LinodeDomainRecord = LinodeResponse<"get-domain-record">;
export type LinodeVpc = LinodeResponse<"get-vpc">;
export type LinodeImage = ApiListItem<operations["get-images"], "data">;
export type LinodeStackScript = ApiListItem<operations["get-stack-scripts"], "data">;
export type LinodeReservedIp = LinodeResponse<"get-reserved-ip">;
export type LinodeRegion = ApiListItem<operations["get-regions"], "data">;
export type LinodeAccount = LinodeResponse<"get-account">;
export type LinodePromotion = NonNullable<LinodeAccount["active_promotions"]>[number];
export type LinodeInvoice = ApiListItem<operations["get-invoices"], "data">;
export type LinodeInvoiceItem = ApiListItem<operations["get-invoice-items"], "data">;
export type LinodeTransfer = LinodeResponse<"get-transfer">;
