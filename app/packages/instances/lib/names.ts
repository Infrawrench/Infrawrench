/**
 * Instance type names, split into family and size, across every platform's
 * naming: `m5.large`, `db.r5.large`, `cache.r6g.large`, `r6g.large.search`,
 * `ml.c6g.4xlarge-Hosting`, `c8i-flex.16xlarge`, `db.r8i.metal-48xl`,
 * `db.r5b.8xlarge.tpc2.mem3x`, EC2 Dedicated Hosts (`m5.host`), Alibaba's
 * `ecs.g7.large`, Azure's VM sizes (`Standard_D2s_v3`: series `Dsv3`, 2
 * vCPUs), Google Cloud's machine types (`n2-standard-2`: `n2-standard`, 2
 * vCPUs), and RunPod's CPU pods (`cpu3c-2-4`: flavor, vCPUs, GB of memory).
 * RunPod's GPU types (`NVIDIA H100 80GB HBM3`) have no sizes and do not
 * parse. The warehouse loader's `familyAndSize`
 * (`web/src/aws-bulk-pricing/warehouse.ts`) follows the same schemes.
 */

const SIZE = /^(nano|micro|small|medium|large|\d*xlarge|metal(?:-\d+xl)?|host)(-.+)?$/;

export interface ParsedName {
  /** e.g. `m5`, `r6g`, `c8i-flex`. */
  family: string;
  /** e.g. `large`, `4xlarge`, `metal-48xl`. */
  size: string;
  /** Names that differ only in size share this, e.g. `db.*.large` for `db.r5.large` is `db.r5.*`. */
  familyKey: string;
  /** Names whose families share a generation (`m5`, `m5a`, `m5dn`) and differ only in that share this. */
  generationKey: string;
}

/** RunPod CPU pods: `cpu3c-2-4` is flavor `cpu3c` with 2 vCPUs and 4 GB. */
const RUNPOD_CPU = /^((cpu\d+)[a-z]*)-(\d+-\d+)$/;

/**
 * Azure: `Standard_` (or `Basic_`), family letters, vCPUs, constrained vCPUs
 * and feature letters (`D2s`, `E64-16as`, `M176ds-44`), then any spacer parts
 * (`A100`), the version (`v5`) and a suffix (`Promo`).
 */
const AZURE_HEAD = /^([A-Z]+)(\d+)(?:-(\d+))?([a-z]*)(?:-(\d+))?$/;

function parseAzure(name: string): ParsedName | null {
  const parts = name.trim().split("_");
  if (parts.length < 2 || (parts[0] !== "Standard" && parts[0] !== "Basic")) return null;
  const head = AZURE_HEAD.exec(parts[1]!);
  if (!head) return null;
  const rest = parts.slice(2);
  const v = rest.findIndex((p) => /^v\d+$/.test(p));
  const middle = v < 0 ? rest : rest.slice(0, v);
  const version = v < 0 ? "" : rest[v]!;
  const suffix = v < 0 ? "" : rest.slice(v + 1).join("_");
  const base = `${head[1]}${head[4]}`;
  // As Azure writes its series: `Dsv3`, `NCads_H100_v5`.
  const family =
    middle.length > 0
      ? [base, ...middle, ...(version ? [version] : [])].join("_")
      : `${base}${version}`;
  const constrained = head[3] ?? head[5];
  return {
    family,
    size: constrained ? `${head[2]}-${constrained}` : head[2]!,
    familyKey: `|${family}|${suffix}`,
    // Sizes of one version share a generation: `Dsv5`, `Ddsv5`, `Dasv5`.
    generationKey: `|${head[1]}${version}|${suffix}`,
  };
}

/** Google Cloud: series, type and vCPUs (`n2-standard-2`), GPUs (`a2-highgpu-1g`), shared core (`e2-micro`), a suffix (`-lssd`). */
const GCP_MACHINE_TYPE =
  /^(([a-z]{1,2}\d+)[a-z]*)-(?:([a-z][a-z0-9]*)-)?(\d+g?|micro|small|medium)(?:-(.+))?$/;

function parseGcp(name: string): ParsedName | null {
  const match = GCP_MACHINE_TYPE.exec(name);
  if (!match) return null;
  const family = match[3] ? `${match[1]}-${match[3]}` : match[1]!;
  const suffix = match[5] ?? "";
  return {
    family,
    size: match[4]!,
    familyKey: `|${family}|${suffix}`,
    // One generation's series and types: `n2-standard`, `n2-highmem`, `n2d-standard`.
    generationKey: `|${match[2]}|${suffix}`,
  };
}

export function parseName(name: string): ParsedName | null {
  if (name.startsWith("Standard_") || name.startsWith("Basic_")) return parseAzure(name);
  if (!name.includes(".")) {
    const gcp = parseGcp(name);
    if (gcp) return gcp;
  }
  const pod = RUNPOD_CPU.exec(name);
  if (pod) {
    return {
      family: pod[1]!,
      size: pod[3]!,
      familyKey: `|${pod[1]}|`,
      generationKey: `|${pod[2]}|`,
    };
  }
  const tokens = name.split(".");
  for (let i = 1; i < tokens.length; i++) {
    const match = SIZE.exec(tokens[i]!);
    if (!match) continue;
    const family = tokens[i - 1]!;
    const before = tokens.slice(0, i - 1).join(".");
    const after = [match[2] ?? "", ...tokens.slice(i + 1)].join(".");
    const generation = /^[a-z]+\d+/.exec(family)?.[0] ?? family;
    return {
      family,
      size: match[1]!,
      familyKey: `${before}|${family}|${after}`,
      generationKey: `${before}|${generation}|${after}`,
    };
  }
  return null;
}

/** Orders sizes small to large: nano … xlarge, 2xlarge … 48xlarge, then metal and hosts; counts by number. */
export function sizeRank(size: string): number {
  const named = ["nano", "micro", "small", "medium", "large", "xlarge"].indexOf(size);
  if (named >= 0) return named;
  const n = /^(\d+)xlarge$/.exec(size);
  if (n) return 5 + Number(n[1]);
  // RunPod CPU pods and Azure's constrained sizes, by vCPUs.
  const pod = /^(\d+)-\d+$/.exec(size);
  if (pod) return Number(pod[1]);
  // Azure's and Google Cloud's sizes are vCPUs (or GPUs, `8g`).
  const count = /^(\d+)g?$/.exec(size);
  if (count) return Number(count[1]);
  if (size.startsWith("metal")) return 1000 + (Number(/\d+/.exec(size)?.[0]) || 0);
  return 2000;
}
