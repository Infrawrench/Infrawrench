import type { InstancePricingCapability, ResourceInstance } from "@infrawrench/plugin-base";

/** RDS engine ids as the price lists write them. */
export const RDS_ENGINES: Readonly<
  Record<string, { engine: string; edition?: string; license?: string }>
> = {
  postgres: { engine: "PostgreSQL" },
  mysql: { engine: "MySQL" },
  mariadb: { engine: "MariaDB" },
  "aurora-postgresql": { engine: "Aurora PostgreSQL" },
  "aurora-mysql": { engine: "Aurora MySQL" },
  // A license is part of the price: SQL Server Standard on db.m5.large is $0.977
  // an hour license-included and $0.30 on its `NA` row, so leaving this open
  // quotes a fraction of the real rate. Enterprise Oracle is BYOL only.
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

export const CACHE_ENGINES: Readonly<Record<string, string>> = {
  valkey: "Valkey",
  redis: "Redis",
  memcached: "Memcached",
};

/** What the price lists call a plain Linux instance; a resource's OS is not in its fields. */
export const EC2_LINUX: Readonly<Record<string, string>> = {
  operating_system: "Linux",
  tenancy: "Shared",
  pre_installed_sw: "NA",
  capacity_status: "Used",
  license_model: "No License required",
};

/** What the price lists call a given RDS engine and deployment. */
export function rdsSelection(engine: string, multiAz: boolean): Record<string, string> {
  const known = RDS_ENGINES[engine];
  return {
    deployment_option: multiAz ? "Multi-AZ" : "Single-AZ",
    ...(known?.engine ? { database_engine: known.engine } : {}),
    ...(known?.edition ? { database_edition: known.edition } : {}),
    ...(known?.license ? { license_model: known.license } : {}),
  };
}

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
    case "rds-instance":
      return panel(
        "rds",
        list(fields["instanceClass"]),
        rdsSelection(
          String(fields["engine"] ?? ""),
          fields["multiAZ"] === true || fields["multiAZ"] === "true",
        ),
      );
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
