/**
 * Instance type names, split into family and size, across every platform's
 * naming: `m5.large`, `db.r5.large`, `cache.r6g.large`, `r6g.large.search`,
 * `ml.c6g.4xlarge-Hosting`, `c8i-flex.16xlarge`, `db.r8i.metal-48xl`,
 * `db.r5b.8xlarge.tpc2.mem3x`, and EC2 Dedicated Hosts (`m5.host`).
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

export function parseName(name: string): ParsedName | null {
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

/** Orders sizes small to large: nano … xlarge, 2xlarge … 48xlarge, then metal and hosts. */
export function sizeRank(size: string): number {
  const named = ["nano", "micro", "small", "medium", "large", "xlarge"].indexOf(size);
  if (named >= 0) return named;
  const n = /^(\d+)xlarge$/.exec(size);
  if (n) return 5 + Number(n[1]);
  if (size.startsWith("metal")) return 1000 + (Number(/\d+/.exec(size)?.[0]) || 0);
  return 2000;
}
