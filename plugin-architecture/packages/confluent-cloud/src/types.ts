/**
 * Wire shapes for the Confluent Cloud APIs this plugin reads, trimmed to the
 * fields it uses. Field names are the ones in the published spec
 * (https://docs.confluent.io/cloud/current/openapi.yaml, 2026-10). Every
 * property is optional because the API omits nulls.
 */

export interface CcObjectMeta {
  self?: string;
  resource_name?: string;
  created_at?: string;
  updated_at?: string;
}

/** `{ id }` references (`EnvScopedObjectReference` and friends). */
export interface CcRef {
  id?: string;
  environment?: string;
  related?: string;
  resource_name?: string;
}

export interface CcEnvironment {
  id?: string;
  metadata?: CcObjectMeta;
  display_name?: string;
  stream_governance_config?: { package?: string };
}

export interface CcClusterConfig {
  kind?: "Basic" | "Standard" | "Dedicated" | "Enterprise" | "Freight" | string;
  cku?: number;
  max_ecku?: number;
  zones?: string[];
}

export interface CcKafkaCluster {
  id?: string;
  metadata?: CcObjectMeta;
  spec?: {
    display_name?: string;
    availability?: string;
    cloud?: string;
    region?: string;
    config?: CcClusterConfig;
    kafka_bootstrap_endpoint?: string;
    http_endpoint?: string;
    api_endpoint?: string;
    deletion_protection?: boolean;
    environment?: CcRef;
    network?: CcRef;
    byok?: CcRef;
  };
  status?: { phase?: string; cku?: number };
}

/** One entry of `GET .../connectors?expand=info,status,id`, keyed by name. */
export interface CcConnectorExpanded {
  id?: { id?: string; id_type?: string };
  info?: { name?: string; type?: string; config?: Record<string, string> };
  status?: {
    name?: string;
    type?: "source" | "sink" | string;
    connector?: { state?: string; worker_id?: string; trace?: string };
    tasks?: Array<{ id?: number; state?: string; worker_id?: string; msg?: string }>;
  };
}

export interface CcComputePool {
  id?: string;
  metadata?: CcObjectMeta;
  spec?: {
    display_name?: string;
    cloud?: string;
    region?: string;
    max_cfu?: number;
    enable_ai?: boolean;
    default_pool?: boolean;
    environment?: CcRef;
    network?: CcRef;
  };
  status?: { phase?: string; current_cfu?: number };
}

export interface CcFlinkRegion {
  id?: string;
  display_name?: string;
  cloud?: string;
  region_name?: string;
}

export interface CcKsqlCluster {
  id?: string;
  metadata?: CcObjectMeta;
  spec?: {
    display_name?: string;
    csu?: number;
    use_detailed_processing_log?: boolean;
    kafka_cluster?: CcRef;
    credential_identity?: CcRef;
    environment?: CcRef;
  };
  status?: {
    http_endpoint?: string;
    phase?: string;
    is_paused?: boolean;
    storage?: number;
    topic_prefix?: string;
  };
}

export interface CcSchemaRegistry {
  id?: string;
  metadata?: CcObjectMeta;
  spec?: {
    display_name?: string;
    package?: string;
    http_endpoint?: string;
    private_http_endpoint?: string;
    catalog_http_endpoint?: string;
    cloud?: string;
    region?: string;
    environment?: CcRef;
  };
  status?: { phase?: string };
}

export interface CcServiceAccount {
  id?: string;
  metadata?: CcObjectMeta;
  display_name?: string;
  description?: string;
}

export interface CcApiKey {
  id?: string;
  metadata?: CcObjectMeta;
  spec?: {
    secret?: string;
    display_name?: string;
    description?: string;
    owner?: CcRef & { kind?: string };
    resource?: CcRef & { kind?: string };
  };
}

export interface CcNetwork {
  id?: string;
  metadata?: CcObjectMeta;
  spec?: {
    display_name?: string;
    cloud?: string;
    region?: string;
    connection_types?: string[];
    cidr?: string;
    zones?: string[];
    environment?: CcRef;
  };
  status?: {
    phase?: string;
    dns_domain?: string;
    active_connection_types?: string[];
    error_message?: string;
    idle_since?: string;
  };
}

/** Peerings, transit gateway attachments and private link accesses. */
export interface CcNetworkConnection {
  id?: string;
  metadata?: CcObjectMeta;
  spec?: {
    display_name?: string;
    cloud?: { kind?: string; [k: string]: unknown };
    environment?: CcRef;
    network?: CcRef;
  };
  status?: { phase?: string; error_message?: string };
}

export interface CcPrivateLinkAttachment {
  id?: string;
  metadata?: CcObjectMeta;
  spec?: { display_name?: string; cloud?: string; region?: string; environment?: CcRef };
  status?: { phase?: string; error_message?: string };
}

export interface CcByokKey {
  id?: string;
  metadata?: CcObjectMeta;
  display_name?: string;
  provider?: string;
  state?: string;
  key?: { kind?: string; key_arn?: string; key_id?: string; key_name?: string };
  validation?: { phase?: string; region?: string; message?: string };
}

/**
 * One Billing Costs line item. Organizations created before 2024-05-15 get
 * the legacy shape, which carries `environment` and `resource_name` at the
 * top level and, per Confluent's community forum, may omit `amount` and
 * `discount_amount`; both shapes are read.
 */
export interface CcCost {
  start_date?: string;
  end_date?: string;
  granularity?: string;
  network_access_type?: string;
  product?: string;
  line_type?: string;
  price?: number;
  unit?: string;
  quantity?: number;
  original_amount?: number;
  discount_amount?: number;
  amount?: number;
  description?: string;
  resource_name?: string;
  environment?: { id?: string };
  resource?: {
    id?: string;
    display_name?: string;
    environment?: { id?: string } | string | null;
  };
}
