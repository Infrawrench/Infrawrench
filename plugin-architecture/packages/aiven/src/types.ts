import type { ApiListItem, ApiResponse } from "@infrawrench/plugin-base";
import type { operations } from "./api-types.gen.js";

/** An operation's response, by its `operationId`. */
type AivenResponse<Op extends keyof operations> = ApiResponse<operations[Op]>;

/**
 * What a mapper accepts: everything optional at every depth. A create answer can
 * come back without the object it made, so a mapper is often handed only the
 * fields that were sent, and the document's `required` is not trusted to hold.
 * A map keeps its shape, because its keys are the provider's and not a schema's.
 */
export type Loose<T> = T extends readonly (infer Item)[]
  ? Loose<Item>[]
  : T extends object
    ? string extends keyof T
      ? T
      : { [K in keyof T]?: Loose<T[K]> }
    : T;

/** One item of a list that may be left out. */
type Item<List> = NonNullable<List> extends readonly (infer One)[] ? One : never;

export type AvProject = ApiListItem<operations["ProjectList"], "projects">;
/** A project from either list route: the organization route has far fewer fields. */
export type AvProjectRow = Loose<AvProject>;
export type AvOrganization = ApiListItem<operations["UserOrganizationsList"], "organizations">;
export type AvService = AivenResponse<"ServiceGet">["service"];
export type AvComponent = Item<AvService["components"]>;
export type AvServiceUser = Item<AvService["users"]>;
export type AvIntegration = Item<AvService["service_integrations"]>;
export type AvPool = Item<AvService["connection_pools"]>;
export type AvAcl = Item<AvService["acl"]>;
export type AvTopic = ApiListItem<operations["ServiceKafkaTopicList"], "topics">;
export type AvTopicDetail = AivenResponse<"ServiceKafkaTopicGet">["topic"];
export type AvConnector = ApiListItem<operations["ServiceKafkaConnectList"], "connectors">;
export type AvVpc = AivenResponse<"VpcGet">;
export type AvVpcRow = ApiListItem<operations["VpcList"], "vpcs">;
export type AvPeering = Item<AvVpc["peering_connections"]>;
export type AvBillingGroup = ApiListItem<operations["BillingGroupList"], "billing_groups">;
/** A billing group from either list route, in the old route's field names. */
export type AvBillingGroupRow = Loose<AvBillingGroup> & { organization_id?: string };
export type AvInvoice = ApiListItem<operations["BillingGroupInvoiceList"], "invoices">;
/** `organization_id` is set when the invoice came from the organization route. */
export type AvInvoiceRow = Loose<AvInvoice> & { organization_id?: string };
export type AvInvoiceLine = ApiListItem<operations["BillingGroupInvoiceLinesList"], "lines">;
/** An invoice line from either route, in the old route's field names. */
export type AvInvoiceLineRow = {
  [K in Exclude<keyof AvInvoiceLine, "service_type" | "tags">]?: AvInvoiceLine[K] | undefined;
} & {
  service_type?: string | undefined;
  tags?: Record<string, string> | undefined;
};
export type AvCredit = ApiListItem<operations["BillingGroupCreditsList"], "credits">;
export type AvPlan = ApiListItem<operations["ProjectServicePlanList"], "service_plans">;
export type AvCloud = ApiListItem<operations["ListClouds"], "clouds">;
export type AvServiceTypes = AivenResponse<"ProjectServiceTypesList">;

/** Whatever `JSON.parse` can give back. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A cell of a chart: the bare value, or `{ v }` in the object row shape. */
export type ChartCell =
  string | number | boolean | null | undefined | { v?: string | number | boolean | null };

/**
 * One metric, a Google Charts DataTable. The document only says `metrics` is an
 * object, so this much is written by hand.
 */
export interface AvMetric {
  data?: {
    cols?: Array<{ label?: string; type?: string }>;
    rows?: Array<ChartCell[] | { c?: Array<ChartCell> }>;
  };
  hints?: { title?: string };
}
