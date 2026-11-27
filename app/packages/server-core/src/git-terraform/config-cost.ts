/**
 * A root's monthly cost from its configuration alone: no state, no plan, and
 * for most of it no connected account. The forge scans a repository's
 * Terraform (`@infrawrench/git-terraform` `scanTerraformSnapshot`) and keeps,
 * per root, every managed resource with its count and the attribute values
 * the configuration sets. This prices them with price data the app already
 * has, and invents none:
 *
 * 1. **Instance list prices** from the instance pricing warehouse (the data
 *    behind instances.infrawrench.com and the plugins' own estimates), read
 *    with `fetchInstanceOnDemandRates`: on-demand hourly rates times 730. It
 *    needs no account, so a personal repository gets these too. Which
 *    Terraform types are priced this way, and which attribute names the size,
 *    is {@link INSTANCE_PRICED}: Terraform's vocabulary mapped onto the
 *    warehouse's, a published dataset, not plugin knowledge.
 * 2. **The organisation's accounts** for everything a plugin maps: the plan
 *    pricer's own path (`plan-cost.ts` `accountPricer`), each plugin's
 *    `estimateCost` over the attributes its export mapper reads back.
 * 3. Everything else is said, not guessed: a resource that may cost a fixed
 *    amount and could not be priced is in `unpriced` with the reason; one
 *    that is billed by use or costs nothing of its own is counted in
 *    `others` (`usage`, `free`) by the name rules below; any other type is
 *    an `unknown` other. **Null is not zero**, and `complete` is false while
 *    `unpriced` or an `unknown` other is not empty.
 *
 * Runs on the gateway (`pass.ts`): it loads plugin code.
 */
import {
  fetchInstanceOnDemandRates,
  type CostEstimate,
  type InstancePricingHostServices,
} from "@infrawrench/plugin-base";
import type {
  ConfigurationCostLine,
  ConfigurationEstimate,
  ConfigurationOther,
  ConfigurationPricingInputs,
  ConfigurationResource,
  ConfigurationUnpriced,
  ConfigurationValue,
} from "@infrawrench/git-terraform";
import type { TerraformLiteral } from "@infrawrench/client-core";

import { accountPricer, type PlanCostAccount, type PlanCostDeps } from "./plan-cost.js";

/** Hours in the month every instance price is quoted over. */
const HOURS_PER_MONTH = 730;
export const MAX_ESTIMATE_LINES = 500;
export const MAX_ESTIMATE_UNPRICED = 500;
/** Resources priced through an account per root: each is a provider pricing call. */
export const MAX_ACCOUNT_PRICED = 60;

// ---------------------------------------------------------------------------
// The warehouse's names for what a Terraform resource runs
// ---------------------------------------------------------------------------

/**
 * RDS engine ids as the price lists write them. The same table as the AWS
 * plugin's `RDS_ENGINES` (`plugin-architecture/packages/aws/src/instance-pricing.ts`),
 * copied because server code never imports a plugin package directly; change
 * the two together.
 */
const RDS_ENGINES: Readonly<
  Record<string, { engine: string; edition?: string; license?: string }>
> = {
  postgres: { engine: "PostgreSQL" },
  mysql: { engine: "MySQL" },
  mariadb: { engine: "MariaDB" },
  "aurora-postgresql": { engine: "Aurora PostgreSQL" },
  "aurora-mysql": { engine: "Aurora MySQL" },
  aurora: { engine: "Aurora MySQL" },
  "oracle-ee": { engine: "Oracle", edition: "Enterprise", license: "Bring your own license" },
  "oracle-ee-cdb": { engine: "Oracle", edition: "Enterprise", license: "Bring your own license" },
  "oracle-se2": { engine: "Oracle", edition: "Standard Two", license: "License included" },
  "oracle-se2-cdb": { engine: "Oracle", edition: "Standard Two", license: "License included" },
  "sqlserver-ee": { engine: "SQL Server", edition: "Enterprise", license: "License included" },
  "sqlserver-se": { engine: "SQL Server", edition: "Standard", license: "License included" },
  "sqlserver-web": { engine: "SQL Server", edition: "Web", license: "License included" },
  "sqlserver-ex": { engine: "SQL Server", edition: "Express", license: "License included" },
  "db2-ae": { engine: "Db2", edition: "Advanced" },
  "db2-se": { engine: "Db2", edition: "Standard" },
};

/** The same as the AWS plugin's `CACHE_ENGINES`. */
const CACHE_ENGINES: Readonly<Record<string, string>> = {
  valkey: "Valkey",
  redis: "Redis",
  memcached: "Memcached",
};

/** What the price lists call a plain Linux instance (the AWS plugin's `EC2_LINUX`). */
const EC2_LINUX: Readonly<Record<string, string>> = {
  operating_system: "Linux",
  tenancy: "Shared",
  pre_installed_sw: "NA",
  capacity_status: "Used",
  license_model: "No License required",
};

/** What a resource runs, in the warehouse's terms, or why that cannot be said. */
type InstanceReading =
  | {
      readonly platform: string;
      /** Attribute the size came from, for the reasons below. */
      readonly sizeAttribute: string;
      readonly instanceType: string | null;
      readonly region: string | null;
      /** Instances per resource instance (a cluster's nodes). Null when not known. */
      readonly nodes: number | null;
      readonly nodesAttribute?: string;
      readonly selection: Readonly<Record<string, string>>;
      /** A note for the line's detail (`Linux`, `Multi-AZ`). */
      readonly note?: string;
    }
  | { readonly unpriced: string };

const str = (value: ConfigurationValue | undefined): string | null =>
  typeof value === "string" && value !== "" ? value : null;
const num = (value: ConfigurationValue | undefined): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
};
const isTrue = (value: ConfigurationValue | undefined): boolean =>
  value === true || value === "true";

/** `us-central1-a` is in `us-central1`. */
const regionOfZone = (zone: string | null): string | null =>
  zone === null ? null : zone.replace(/-[a-z]$/, "");

/** Azure's display names (`West Europe`) are its ARM names written out. */
const azureRegion = (location: string | null): string | null =>
  location === null ? null : location.toLowerCase().replace(/\s+/g, "");

interface InstanceSpec {
  /** Reads the resource, or says why it cannot be priced. */
  read(resource: ConfigurationResource): InstanceReading;
}

function attr(resource: ConfigurationResource, name: string): ConfigurationValue | undefined {
  return resource.attributes[name];
}

/** The size, or null; its absence is reported against `name`. */
function size(resource: ConfigurationResource, name: string): string | null {
  return str(attr(resource, name));
}

/** A count attribute with a default, or null when it is set but not known. */
function nodesOf(
  resource: ConfigurationResource,
  name: string,
  fallback: number | null,
): number | null {
  if (resource.unknownAttributes.includes(name)) return null;
  const value = num(attr(resource, name));
  return value === null ? fallback : Math.max(0, Math.floor(value));
}

const aws = (
  platform: string,
  sizeAttribute: string,
  selection: (resource: ConfigurationResource) => Record<string, string> = () => ({}),
  nodes: (resource: ConfigurationResource) => {
    count: number | null;
    attribute?: string;
  } = () => ({ count: 1 }),
  note?: (resource: ConfigurationResource) => string | undefined,
): InstanceSpec => ({
  read: (resource) => {
    const counted = nodes(resource);
    const extra = note?.(resource);
    return {
      platform,
      sizeAttribute,
      instanceType: size(resource, sizeAttribute),
      region: resource.providerRegion,
      nodes: counted.count,
      ...(counted.attribute ? { nodesAttribute: counted.attribute } : {}),
      selection: selection(resource),
      ...(extra ? { note: extra } : {}),
    };
  },
});

function rdsSelection(resource: ConfigurationResource): Record<string, string> | null {
  const engine = str(attr(resource, "engine"));
  const known = engine === null ? undefined : RDS_ENGINES[engine];
  if (!known) return null;
  return {
    deployment_option: isTrue(attr(resource, "multi_az")) ? "Multi-AZ" : "Single-AZ",
    database_engine: known.engine,
    ...(known.edition ? { database_edition: known.edition } : {}),
    ...(known.license ? { license_model: known.license } : {}),
  };
}

const rds = (sizeAttribute: string): InstanceSpec => ({
  read: (resource) => {
    if (resource.unknownAttributes.includes("engine")) {
      return { unpriced: "engine is not known from the configuration" };
    }
    const selection = rdsSelection(resource);
    if (selection === null) {
      const engine = str(attr(resource, "engine"));
      return {
        unpriced:
          engine === null
            ? "engine is not set"
            : `no list prices are kept for the ${engine} engine`,
      };
    }
    return {
      platform: "rds",
      sizeAttribute,
      instanceType: size(resource, sizeAttribute),
      region: resource.providerRegion,
      nodes: 1,
      selection,
      note: `${selection["database_engine"]}, ${selection["deployment_option"]}`,
    };
  },
});

const cacheEngine = (resource: ConfigurationResource, fallback: string): Record<string, string> => {
  const engine = CACHE_ENGINES[str(attr(resource, "engine")) ?? fallback];
  return engine ? { cache_engine: engine } : {};
};

const azure = (sizeAttribute: string, os: "Linux" | "Windows", nodes?: string): InstanceSpec => ({
  read: (resource) => {
    const spot = /^spot$/i.test(str(attr(resource, "priority")) ?? "");
    return {
      platform: "azure",
      sizeAttribute,
      instanceType: size(resource, sizeAttribute),
      region: azureRegion(str(attr(resource, "location"))),
      nodes: nodes ? nodesOf(resource, nodes, 1) : 1,
      ...(nodes ? { nodesAttribute: nodes } : {}),
      selection: { operating_system: os, "variant.priority": spot ? "Spot" : "Regular" },
      note: spot ? `${os}, Spot` : os,
    };
  },
});

/**
 * The Terraform types priced from instance list prices, by what names their
 * size. Each answers the warehouse's `platform`, `instance_type`, `region`
 * and variant (see `@infrawrench/client-core` `PricingWarehouse`).
 */
export const INSTANCE_PRICED: Readonly<Record<string, InstanceSpec>> = {
  aws_instance: aws(
    "ec2",
    "instance_type",
    (resource) => ({
      ...EC2_LINUX,
      tenancy: str(attr(resource, "tenancy")) === "dedicated" ? "Dedicated" : "Shared",
    }),
    undefined,
    () => "Linux",
  ),
  aws_db_instance: rds("instance_class"),
  aws_rds_cluster_instance: rds("instance_class"),
  aws_docdb_cluster_instance: aws("docdb", "instance_class"),
  aws_neptune_cluster_instance: aws("neptune", "instance_class"),
  aws_elasticache_cluster: aws(
    "elasticache",
    "node_type",
    (resource) => cacheEngine(resource, "redis"),
    (resource) => ({
      count: nodesOf(resource, "num_cache_nodes", 1),
      attribute: "num_cache_nodes",
    }),
  ),
  aws_elasticache_replication_group: aws(
    "elasticache",
    "node_type",
    (resource) => cacheEngine(resource, "redis"),
    (resource) => {
      const clusters = nodesOf(resource, "num_cache_clusters", null);
      if (clusters !== null || resource.unknownAttributes.includes("num_cache_clusters")) {
        return { count: clusters, attribute: "num_cache_clusters" };
      }
      const groups = nodesOf(resource, "num_node_groups", 1);
      const replicas = nodesOf(resource, "replicas_per_node_group", 0);
      return {
        count: groups === null || replicas === null ? null : groups * (replicas + 1),
        attribute: "num_node_groups",
      };
    },
  ),
  aws_memorydb_cluster: aws(
    "memorydb",
    "node_type",
    (resource) => cacheEngine(resource, "redis"),
    (resource) => {
      const shards = nodesOf(resource, "num_shards", 1);
      const replicas = nodesOf(resource, "num_replicas_per_shard", 1);
      return {
        count: shards === null || replicas === null ? null : shards * (replicas + 1),
        attribute: "num_shards",
      };
    },
  ),
  aws_redshift_cluster: aws("redshift", "node_type", undefined, (resource) => ({
    count: nodesOf(resource, "number_of_nodes", 1),
    attribute: "number_of_nodes",
  })),
  aws_opensearch_domain: aws(
    "opensearch",
    "cluster_config.instance_type",
    undefined,
    (resource) => ({
      count: nodesOf(resource, "cluster_config.instance_count", 1),
      attribute: "cluster_config.instance_count",
    }),
  ),
  aws_elasticsearch_domain: aws(
    "opensearch",
    "cluster_config.instance_type",
    undefined,
    (resource) => ({
      count: nodesOf(resource, "cluster_config.instance_count", 1),
      attribute: "cluster_config.instance_count",
    }),
  ),
  aws_eks_node_group: {
    read: (resource) => {
      const types = attr(resource, "instance_types");
      // The provider's default, when the configuration sets none.
      const first = Array.isArray(types)
        ? (types[0] ?? null)
        : resource.unknownAttributes.includes("instance_types")
          ? null
          : "t3.medium";
      return {
        platform: "ec2",
        sizeAttribute: "instance_types",
        instanceType: first,
        region: resource.providerRegion,
        nodes: nodesOf(resource, "scaling_config.desired_size", null),
        nodesAttribute: "scaling_config.desired_size",
        selection: EC2_LINUX,
        note: "Linux",
      };
    },
  },
  google_compute_instance: {
    read: (resource) => {
      const spot =
        /^spot$/i.test(str(attr(resource, "scheduling.provisioning_model")) ?? "") ||
        isTrue(attr(resource, "scheduling.preemptible"));
      return {
        platform: "gcp",
        sizeAttribute: "machine_type",
        instanceType: size(resource, "machine_type"),
        region: regionOfZone(str(attr(resource, "zone"))) ?? resource.providerRegion,
        nodes: 1,
        selection: { "variant.provisioningModel": spot ? "Spot" : "Standard" },
        ...(spot ? { note: "Spot" } : {}),
      };
    },
  },
  azurerm_linux_virtual_machine: azure("size", "Linux"),
  azurerm_windows_virtual_machine: azure("size", "Windows"),
  azurerm_virtual_machine: azure("vm_size", "Linux"),
  azurerm_linux_virtual_machine_scale_set: azure("sku", "Linux", "instances"),
  azurerm_windows_virtual_machine_scale_set: azure("sku", "Windows", "instances"),
  hcloud_server: {
    read: (resource) => ({
      platform: "hetzner",
      sizeAttribute: "server_type",
      instanceType: size(resource, "server_type"),
      region: str(attr(resource, "location")),
      nodes: 1,
      selection: {},
    }),
  },
  alicloud_instance: {
    read: (resource) => ({
      platform: "alibaba",
      sizeAttribute: "instance_type",
      instanceType: size(resource, "instance_type"),
      region: resource.providerRegion,
      nodes: 1,
      selection: { operating_system: "Linux", "variant.networkType": "VPC" },
      note: "Linux",
    }),
  },
  oci_core_instance: {
    read: (resource) => {
      const shape = size(resource, "shape");
      if (shape !== null && shape.endsWith(".Flex")) {
        // A flexible shape is priced by its OCPUs and memory, which the
        // warehouse lists as `<shape>-<ocpus>-<GB>`.
        const ocpus = num(attr(resource, "shape_config.ocpus"));
        const memory = num(attr(resource, "shape_config.memory_in_gbs"));
        if (ocpus === null || memory === null) {
          return {
            unpriced: "flexible shape: priced by its OCPUs and memory, which are not known",
          };
        }
        return {
          platform: "oracle",
          sizeAttribute: "shape",
          instanceType: `${shape}-${ocpus}-${memory}`,
          region: "global",
          nodes: 1,
          selection: {},
        };
      }
      // Oracle Cloud lists one price for every region.
      return {
        platform: "oracle",
        sizeAttribute: "shape",
        instanceType: shape,
        region: "global",
        nodes: 1,
        selection: {},
      };
    },
  },
  ibm_is_instance: {
    read: (resource) => ({
      platform: "ibm",
      sizeAttribute: "profile",
      instanceType: size(resource, "profile"),
      region: resource.providerRegion,
      nodes: 1,
      selection: {},
    }),
  },
};

// ---------------------------------------------------------------------------
// What a configuration cannot price, by name
// ---------------------------------------------------------------------------

/**
 * Billed by what it does (requests, bytes stored, messages), which a
 * configuration does not say. Matched on the type's name.
 */
const USAGE =
  /^(aws_(lambda_|s3_|sqs_|sns_|dynamodb_|ecr_repository$|secretsmanager_|cloudwatch_log_|cloudwatch_event_|scheduler_|apigatewayv2?_|api_gateway_|kinesis_|athena_|glue_|sfn_|cloudfront_)|google_(storage_|pubsub_|cloudfunctions2?_|cloud_run_|artifact_registry_repository$|bigquery_|logging_)|azurerm_(storage_|function_app|eventhub|servicebus)|oci_(objectstorage_|artifacts_container_repository$|functions_)|cloudflare_(r2_|worker|workers_|queue))/;

/**
 * No charge of its own: identities, permissions, policies, network wiring,
 * attachments of one thing to another, DNS records. Matched on the type's
 * name; a name that also fits a billed thing (`aws_vpc_endpoint`,
 * `aws_autoscaling_group`) is kept out by the exclusion.
 */
const FREE =
  /(_iam_|_identity_|_policy$|_policy_|_attachment$|_association$|_route_table$|_route$|_security_group|_security_list$|_subnet$|_vpc$|_vcn$|_internet_gateway$|_permission$|_member$|_binding$|_service_account|_project_service$|_compartment$|_role$|_user$|_group$|_group_membership$|_key_pair$|_public_access_block$|_alias$|_instance_profile$|_openid_connect_provider$|_workload_identity_pool|_auth_token$|_api_key$|_preauthrequest$|_network_acl|_dhcp_options|_resource_group$|_function_url$|_secret_version$|_ssm_parameter$|_record$|_dns_record$|_route53_record$|_tag$|_tags$)/;
const NOT_FREE = /(_autoscaling_group$|_node_group$|_instance_group$|_vpc_endpoint|_log_group$)/;

/** Fixed price, no list price in the warehouse: priced through an account, or not at all. */
const FIXED =
  /^(aws_(nat_gateway|lb|alb|elb|eip|ebs_volume|vpc_endpoint|kms_key|eks_cluster|route53_zone|db_proxy|efs_file_system|fsx_|ec2_transit_gateway|vpn_connection|globalaccelerator_accelerator|mq_broker|msk_cluster)|google_(compute_address|compute_global_address|compute_disk|sql_database_instance|container_cluster|container_node_pool|compute_router_nat|redis_instance|filestore_instance|compute_forwarding_rule)|azurerm_(public_ip|managed_disk|kubernetes_cluster|postgresql_|mysql_|mssql_|redis_cache|lb$|application_gateway|nat_gateway)|digitalocean_|linode_|vultr_|scaleway_|exoscale_|upcloud_|hcloud_(volume|load_balancer|primary_ip|floating_ip)|oci_(core_volume|load_balancer|database_|mysql_))/;

export function classifyOther(type: string): ConfigurationOther["kind"] | "fixed" {
  if (USAGE.test(type)) return "usage";
  if (FIXED.test(type)) return "fixed";
  if (FREE.test(type) && !NOT_FREE.test(type)) return "free";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export interface ConfigCostDeps extends PlanCostDeps {
  /** The instance pricing warehouse; undefined on a deployment without one. */
  pricing: InstancePricingHostServices | undefined;
  /** The organisation's accounts, first per plugin decides. Empty for a personal namespace. */
  accounts: readonly PlanCostAccount[];
  /** A plugin's display name, for reasons (`AWS`). */
  pluginName: (pluginId: string) => string;
}

export interface PricedConfiguration {
  readonly estimate: ConfigurationEstimate;
  /** At least one price source answered: the warehouse is there, or an account priced something. */
  readonly sourced: boolean;
}

const cents = (amount: number): number => Math.round(amount * 100) / 100;
const money = (amount: number): string =>
  `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function literalAttributes(resource: ConfigurationResource): Record<string, TerraformLiteral> {
  const out: Record<string, TerraformLiteral> = {};
  for (const [name, value] of Object.entries(resource.attributes)) {
    if (!Array.isArray(value)) out[name] = value as TerraformLiteral;
  }
  return out;
}

/**
 * Prices one root's configuration. `organizationId` is null for a personal
 * namespace, which has no accounts: only list prices apply there.
 */
export async function priceConfiguration(
  organizationId: string | null,
  inputs: ConfigurationPricingInputs,
  deps: ConfigCostDeps,
): Promise<PricedConfiguration> {
  const lines: ConfigurationCostLine[] = [];
  const unpriced: ConfigurationUnpriced[] = [];
  const others = new Map<
    string,
    { type: string; count: number; kind: ConfigurationOther["kind"] }
  >();
  const other = (type: string, kind: ConfigurationOther["kind"], count: number) => {
    const key = `${kind}\u0000${type}`;
    const known = others.get(key);
    if (known) known.count += count;
    else others.set(key, { type, count, kind });
  };
  const pricer = accountPricer(
    organizationId ?? "",
    organizationId === null ? [] : deps.accounts,
    deps,
  );
  let sourced = deps.pricing !== undefined;
  let accountCalls = 0;

  /** Warehouse reads, one per platform, region and variant. */
  interface Wanted {
    resource: ConfigurationResource;
    reading: Extract<InstanceReading, { platform: string }>;
    instanceType: string;
    region: string;
    total: number;
  }
  const wanted: Wanted[] = [];

  for (const resource of inputs.resources) {
    const spec = INSTANCE_PRICED[resource.type];
    if (spec) {
      if (resource.count === null) {
        unpriced.push({
          address: resource.address,
          type: resource.type,
          reason: "count or for_each is not known from the configuration",
        });
        continue;
      }
      const reading = spec.read(resource);
      if ("unpriced" in reading) {
        unpriced.push({ address: resource.address, type: resource.type, reason: reading.unpriced });
        continue;
      }
      const sizeName = reading.sizeAttribute;
      if (reading.instanceType === null) {
        unpriced.push({
          address: resource.address,
          type: resource.type,
          reason: resource.unknownAttributes.includes(sizeName)
            ? `${sizeName} is not known from the configuration`
            : `${sizeName} is not set`,
        });
        continue;
      }
      if (reading.nodes === null) {
        unpriced.push({
          address: resource.address,
          type: resource.type,
          reason: `${reading.nodesAttribute ?? "the node count"} is not known from the configuration`,
        });
        continue;
      }
      if (reading.region === null) {
        unpriced.push({
          address: resource.address,
          type: resource.type,
          reason: "region is not set in the configuration",
        });
        continue;
      }
      if (!deps.pricing) {
        unpriced.push({
          address: resource.address,
          type: resource.type,
          reason: "this deployment has no instance price data",
        });
        continue;
      }
      const total = resource.count * reading.nodes;
      if (total === 0) continue;
      wanted.push({
        resource,
        reading,
        instanceType: reading.instanceType,
        region: reading.region,
        total,
      });
      continue;
    }

    const kind = classifyOther(resource.type);
    if (kind === "usage" || kind === "free") {
      other(resource.type, kind, resource.count ?? 1);
      continue;
    }
    // A plugin may price it through one of the organisation's accounts.
    const pluginId = pricer.pluginFor(resource.type);
    if (pluginId !== null && organizationId !== null && accountCalls < MAX_ACCOUNT_PRICED) {
      if (resource.count === null) {
        unpriced.push({
          address: resource.address,
          type: resource.type,
          reason: "count or for_each is not known from the configuration",
        });
        continue;
      }
      accountCalls++;
      const estimate: CostEstimate | null | undefined = await pricer.price(
        resource.type,
        literalAttributes(resource),
      );
      if (estimate && estimate.currency !== "USD") {
        unpriced.push({
          address: resource.address,
          type: resource.type,
          reason: `priced in ${estimate.currency}, and the estimate is in USD`,
        });
        continue;
      }
      if (estimate) {
        sourced = true;
        if (resource.count === 0) continue;
        const each = estimate.monthlyAmount;
        lines.push({
          address: resource.address,
          type: resource.type,
          count: resource.count,
          monthly: cents(each * resource.count),
          detail: `${resource.count} × ${money(each)} a month, from the connected ${deps.pluginName(pluginId)} account's pricing${estimate.partial ? " (partial)" : ""}`,
        });
        continue;
      }
      if (estimate === undefined && pricer.hasAccount(pluginId)) {
        if (kind === "fixed") {
          unpriced.push({
            address: resource.address,
            type: resource.type,
            reason: `the connected ${deps.pluginName(pluginId)} account's pricing had no price for it`,
          });
        } else other(resource.type, "unknown", resource.count);
        continue;
      }
    }
    if (kind === "fixed") {
      unpriced.push({
        address: resource.address,
        type: resource.type,
        reason:
          pluginId !== null
            ? `priced through a connected ${deps.pluginName(pluginId)} account; none is connected`
            : "fixed price that the price data does not hold",
      });
      continue;
    }
    other(resource.type, "unknown", resource.count ?? 1);
  }

  // The warehouse, a query per platform, region and variant.
  const groups = new Map<string, Wanted[]>();
  for (const item of wanted) {
    const key = JSON.stringify([item.reading.platform, item.region, item.reading.selection]);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const first = group[0]!;
    const rates = await fetchInstanceOnDemandRates(deps.pricing, {
      platform: first.reading.platform,
      region: first.region,
      instanceTypes: group.map((item) => item.instanceType),
      selection: first.reading.selection,
    });
    // The warehouse did not answer: not the configuration's fault. The caller retries.
    if (rates === null) throw new Error("The instance price data did not answer");
    for (const item of group) {
      const hourly = rates[item.instanceType];
      if (hourly === undefined) {
        unpriced.push({
          address: item.resource.address,
          type: item.resource.type,
          reason: `no list price for ${item.instanceType} in ${item.region}`,
        });
        continue;
      }
      const each = cents(hourly * HOURS_PER_MONTH);
      lines.push({
        address: item.resource.address,
        type: item.resource.type,
        count: item.total,
        monthly: cents(each * item.total),
        detail: [
          `${item.total} × ${item.instanceType}`,
          item.region,
          ...(item.reading.note ? [item.reading.note] : []),
          `on demand, ${money(each)} each`,
        ].join(", "),
      });
    }
  }

  // An unread module may hold anything.
  for (const module of inputs.unreadModules) {
    unpriced.push({
      address: module.address,
      type: "module",
      reason:
        module.source === null
          ? "a module whose source is not a plain string is not read"
          : `a module from ${module.source} is not read`,
    });
  }
  if (inputs.truncated) {
    unpriced.push({
      address: inputs.root === "" ? "/" : inputs.root,
      type: "configuration",
      reason: "the configuration is larger than is read: more resources are not listed",
    });
  }

  lines.sort((a, b) => b.monthly - a.monthly || (a.address < b.address ? -1 : 1));
  unpriced.sort((a, b) => (a.address < b.address ? -1 : 1));
  const otherList = [...others.values()].sort(
    (a, b) => b.count - a.count || (a.type < b.type ? -1 : 1),
  );
  const total = lines.reduce((sum, line) => sum + line.monthly, 0);
  return {
    sourced,
    estimate: {
      currency: lines.length > 0 ? "USD" : null,
      monthlyTotal: lines.length > 0 ? cents(total) : null,
      complete: unpriced.length === 0 && !otherList.some((item) => item.kind === "unknown"),
      lines: lines.slice(0, MAX_ESTIMATE_LINES),
      unpriced: unpriced.slice(0, MAX_ESTIMATE_UNPRICED),
      others: otherList,
    },
  };
}
