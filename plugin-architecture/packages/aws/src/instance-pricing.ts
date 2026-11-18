import type {
  InstancePricingCapability,
  InstancePricingUsage,
  ResourceInstance,
} from "@infrawrench/plugin-base";

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

function count(value: unknown): number | null {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * What a synced AWS resource pays for by the hour, for the price-change watch.
 * A stopped instance pays no instance-hours, so it has none. A cluster with
 * one node type is priced at its node count; with several, the split between
 * them is not synced, so each counts once and the figure is a lower bound.
 */
export function awsInstancePricingUsage(resource: ResourceInstance): InstancePricingUsage[] {
  const fields = resource.fields;
  const region = String(fields["region"] ?? "");
  if (!region) return [];
  const usage = (
    platform: string,
    types: string[],
    units: number | null,
    selection?: Record<string, string>,
  ): InstancePricingUsage[] => {
    const exact = types.length === 1 && units !== null;
    return types.map((instanceType) => ({
      platform,
      instanceType,
      region,
      ...(selection ? { selection } : {}),
      units: exact && units !== null ? units : 1,
      ...(exact ? {} : { approximate: true }),
    }));
  };
  switch (resource.resourceTypeId) {
    case "ec2-instance": {
      const state = String(fields["state"] ?? "").toLowerCase();
      if (state && state !== "running" && state !== "pending") return [];
      return usage("ec2", list(fields["instanceType"]), 1, { ...EC2_LINUX });
    }
    case "eks-cluster":
      return usage("ec2", list(fields["instanceTypes"]), count(fields["nodeCount"]), {
        ...EC2_LINUX,
      });
    case "rds-instance": {
      if (String(fields["status"] ?? "").toLowerCase() === "stopped") return [];
      return usage(
        "rds",
        list(fields["instanceClass"]),
        1,
        rdsSelection(
          String(fields["engine"] ?? ""),
          fields["multiAZ"] === true || fields["multiAZ"] === "true",
        ),
      );
    }
    case "elasticache-cluster": {
      const engine = CACHE_ENGINES[String(fields["engine"] ?? "")];
      return usage(
        "elasticache",
        list(fields["nodeType"]),
        count(fields["numCacheNodes"] ?? fields["numNodes"]),
        engine ? { cache_engine: engine } : {},
      );
    }
    case "opensearch-domain":
      return usage("opensearch", list(fields["instanceType"]), count(fields["instanceCount"]));
    case "redshift-cluster":
      return usage("redshift", list(fields["nodeType"]), count(fields["numberOfNodes"]));
    default:
      return [];
  }
}
