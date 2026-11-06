import type { InstancePricingCapability, ResourceInstance } from "@infrawrench/plugin-base";

/** RDS engine ids as the price lists write them. */
const RDS_ENGINES: Readonly<Record<string, { engine: string; edition?: string }>> = {
  postgres: { engine: "PostgreSQL" },
  mysql: { engine: "MySQL" },
  mariadb: { engine: "MariaDB" },
  "aurora-postgresql": { engine: "Aurora PostgreSQL" },
  "aurora-mysql": { engine: "Aurora MySQL" },
  "oracle-ee": { engine: "Oracle", edition: "Enterprise" },
  "oracle-ee-cdb": { engine: "Oracle", edition: "Enterprise" },
  "oracle-se2": { engine: "Oracle", edition: "Standard Two" },
  "oracle-se2-cdb": { engine: "Oracle", edition: "Standard Two" },
  "sqlserver-ee": { engine: "SQL Server", edition: "Enterprise" },
  "sqlserver-se": { engine: "SQL Server", edition: "Standard" },
  "sqlserver-web": { engine: "SQL Server", edition: "Web" },
  "sqlserver-ex": { engine: "SQL Server", edition: "Express" },
  "db2-ae": { engine: "Db2", edition: "Advanced" },
  "db2-se": { engine: "Db2", edition: "Standard" },
};

const CACHE_ENGINES: Readonly<Record<string, string>> = {
  valkey: "Valkey",
  redis: "Redis",
  memcached: "Memcached",
};

/** What the price lists call a plain Linux instance; a resource's OS is not in its fields. */
const EC2_LINUX: Readonly<Record<string, string>> = {
  operating_system: "Linux",
  tenancy: "Shared",
  pre_installed_sw: "NA",
  capacity_status: "Used",
  license_model: "No License required",
};

function list(value: unknown): string[] {
  return String(value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** The pricing panel's reading of an AWS resource; undefined for types it has no prices for. */
export function awsInstancePricing(
  resource: ResourceInstance,
  region: string,
): InstancePricingCapability | undefined {
  const fields = resource.fields;
  const panel = (
    platform: string,
    instanceTypes: string[],
    selection?: Record<string, string>,
  ): InstancePricingCapability | undefined =>
    instanceTypes.length === 0
      ? undefined
      : { platform, instanceTypes, region, ...(selection ? { selection } : {}) };

  switch (resource.resourceTypeId) {
    case "ec2-instance":
      return panel("ec2", list(fields["instanceType"]), { ...EC2_LINUX });
    case "eks-cluster":
      return panel("ec2", list(fields["instanceTypes"]), { ...EC2_LINUX });
    case "rds-instance": {
      const engine = RDS_ENGINES[String(fields["engine"] ?? "")];
      return panel("rds", list(fields["instanceClass"]), {
        deployment_option:
          fields["multiAZ"] === true || fields["multiAZ"] === "true" ? "Multi-AZ" : "Single-AZ",
        ...(engine?.engine ? { database_engine: engine.engine } : {}),
        ...(engine?.edition ? { database_edition: engine.edition } : {}),
      });
    }
    case "elasticache-cluster": {
      const engine = CACHE_ENGINES[String(fields["engine"] ?? "")];
      return panel("elasticache", list(fields["nodeType"]), engine ? { cache_engine: engine } : {});
    }
    case "opensearch-domain":
      return panel("opensearch", list(fields["instanceType"]));
    case "redshift-cluster":
      return panel("redshift", list(fields["nodeType"]));
    default:
      return undefined;
  }
}
