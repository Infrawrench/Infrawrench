/**
 * The slices of Elastic Cloud API responses this plugin reads. Field names are
 * the ones in Elastic's published OpenAPI documents (2026-10):
 * https://www.elastic.co/docs/api/doc/cloud.json (Cloud API),
 * https://www.elastic.co/docs/api/doc/elastic-cloud-serverless.json
 * (Serverless) and https://www.elastic.co/docs/api/doc/cloud-billing.json
 * (Billing). Every field is optional here because a missing one must degrade
 * to a blank cell rather than a crash.
 */

export interface EcOrganization {
  id?: string;
  name?: string;
  billing_contacts?: string[];
  operational_contacts?: string[];
}

export interface EcTopologySize {
  value?: number;
  resource?: string;
}

export interface EcTopologyElement {
  id?: string;
  zone_count?: number;
  instance_configuration_id?: string;
  size?: EcTopologySize;
  autoscaling_max?: EcTopologySize;
  node_roles?: string[];
}

export interface EcClusterMetadata {
  endpoint?: string;
  service_url?: string;
  aliased_endpoint?: string;
  aliased_url?: string;
  cloud_id?: string;
}

export interface EcInstanceInfo {
  instance_name?: string;
  healthy?: boolean;
  zone?: string;
  memory?: {
    instance_capacity?: number;
    memory_pressure?: number;
    native_memory_pressure?: number;
  };
  disk?: { disk_space_available?: number; disk_space_used?: number };
}

export interface EcClusterInfo {
  cluster_id?: string;
  cluster_name?: string;
  healthy?: boolean;
  status?: string;
  region?: string;
  metadata?: EcClusterMetadata;
  topology?: { healthy?: boolean; instances?: EcInstanceInfo[] };
  plan_info?: {
    healthy?: boolean;
    current?: {
      plan?: {
        elasticsearch?: { version?: string };
        kibana?: { version?: string };
        cluster_topology?: EcTopologyElement[];
        deployment_template?: { id?: string };
        autoscaling_enabled?: boolean;
      };
    };
    pending?: { plan_attempt_id?: string } | null;
  };
}

export interface EcResourceInfo {
  ref_id?: string;
  id?: string;
  region?: string;
  info?: EcClusterInfo;
}

export interface EcDeployment {
  id?: string;
  name?: string;
  alias?: string;
  healthy?: boolean;
  resources?: {
    elasticsearch?: EcResourceInfo[];
    kibana?: EcResourceInfo[];
    apm?: EcResourceInfo[];
    integrations_server?: EcResourceInfo[];
    enterprise_search?: EcResourceInfo[];
  };
  settings?: {
    traffic_filter_settings?: { rulesets?: string[] };
    autoscaling_enabled?: boolean;
    solution_type?: string;
  };
  metadata?: { tags?: Array<{ key?: string; value?: string }> };
}

export interface EcDeploymentListing {
  id?: string;
  name?: string;
  resources?: Array<{ kind?: string; ref_id?: string; region?: string; cloud_id?: string }>;
}

export interface EcTierInfo {
  memory_size?: number;
  zone_count?: number;
  available_sizes?: number[];
}

export type EcTiers = Partial<
  Record<"hot_content" | "warm" | "cold" | "frozen" | "master" | "coordinating" | "ml", EcTierInfo>
>;

export interface EcTrafficRule {
  id?: string;
  source?: string;
  description?: string;
  azure_endpoint_name?: string;
  azure_endpoint_guid?: string;
  remote_cluster_id?: string;
  remote_cluster_org_id?: string;
  egress_rule?: { target?: string; ports?: number[]; protocol?: string };
}

export interface EcTrafficRuleset {
  id?: string;
  name?: string;
  description?: string;
  type?: string;
  include_by_default?: boolean;
  region?: string;
  rules?: EcTrafficRule[];
  associations?: Array<{ entity_type?: string; id?: string }>;
  total_associations?: number;
}

export interface EcExtension {
  id?: string;
  name?: string;
  description?: string;
  url?: string;
  download_url?: string;
  extension_type?: string;
  version?: string;
  deployments?: string[];
  file_metadata?: { last_modified_date?: string; size?: number };
}

/** Serverless project types: one path segment each under `/api/v1/serverless/projects/`. */
export const PROJECT_TYPES = ["elasticsearch", "observability", "security", "vectordb"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export interface EcProject {
  id?: string;
  name?: string;
  alias?: string;
  region_id?: string;
  cloud_id?: string;
  type?: string;
  optimized_for?: string;
  product_tier?: string;
  product_types?: Array<{ product_line?: string; product_tier?: string }>;
  search_lake?: { search_power?: number; boost_window?: number };
  data?: { max_retention_days?: number | null; default_retention_days?: number | null };
  endpoints?: Record<string, string | undefined>;
  traffic_filters?: Array<{ id?: string }>;
  metadata?: {
    created_at?: string;
    created_by?: string;
    organization_id?: string;
    suspended_at?: string;
    suspended_reason?: string;
    tags?: Record<string, string>;
  };
}

export interface EcServerlessRegion {
  id?: string;
  name?: string;
  csp?: string;
  csp_region?: string;
  project_creation_enabled?: boolean;
}

export interface EcServerlessTrafficFilter {
  id?: string;
  name?: string;
  description?: string;
  type?: string;
  include_by_default?: boolean;
  region?: string;
  rules?: EcTrafficRule[];
}

/** v1 costs overview (`GET /api/v1/billing/costs/{organization_id}`). */
export interface EcCostsOverview {
  costs?: { total?: number; dimensions?: Array<{ type?: string; cost?: number }> };
  trials?: number;
  hourly_rate?: number;
  balance?: {
    available?: number;
    remaining?: number;
    line_items?: Array<{
      id?: string;
      ecu_quantity?: number;
      ecu_balance?: number;
      start?: string;
      end?: string;
    }>;
  };
}

/** One billed line inside an instance (v2 billing). */
export interface EcProductLineItem {
  name?: string;
  type?: string;
  kind?: string | null;
  sku?: string;
  unit?: string;
  total_ecu?: number;
  quantity?: { value?: number; formatted_value?: string };
  rate?: { value?: number; formatted_value?: string };
}

/** v2 `GET .../costs/instances`: one entry per deployment, project or service. */
export interface EcInstanceCosts {
  total_ecu?: number;
  instances?: Array<{
    id?: string;
    name?: string;
    type?: string;
    total_ecu?: number;
    product_line_items?: EcProductLineItem[];
  }>;
}

export interface EcChartItems {
  data?: Array<{
    timestamp?: number;
    values?: Array<{ id?: string; name?: string; type?: string; value?: number }>;
  }>;
}

export interface EcBudget {
  id?: number;
  name?: string;
  amount?: number;
  period?: string;
  active?: boolean;
  scope_type?: string;
  scope_values?: string[];
  recipient_group?: string[];
  created_at?: string;
  alerts?: Array<{
    id?: number;
    operator?: string;
    threshold?: number;
    threshold_type?: string;
    last_exceeded_at?: string;
  }>;
}
