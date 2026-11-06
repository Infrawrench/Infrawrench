/**
 * Loads the bulk pricing bundles (every AWS platform, Hetzner, OVHcloud, Oracle Cloud, IBM Cloud, RunPod, Alibaba Cloud
 * ECS, Azure virtual machines and Google Cloud Compute Engine) into the
 * instance pricing warehouse
 * (ClickHouse; tables in `@infrawrench/server-core/aws-pricing-warehouse/schema`),
 * which instances.infrawrench.com's chat queries.
 *
 * Runs inside the bundle sync (`sync.ts`), from the same stream of instances
 * the KV values are cut from: each instance's reduced value becomes its price
 * periods, its spec row and its attribute history. A bundle is loaded whole
 * into the `staging` database and then swapped into the live tables one
 * partition per table (`REPLACE PARTITION`), so readers never see a platform
 * half loaded; `sync_state` goes last and records the version, so a load that
 * dies part way is redone by the next run.
 *
 * Rows are sent as RowBinary, which is about a third of the size of
 * JSONEachRow, in bodies of a few MB: the warehouse is CloudHouse (ClickHouse
 * on Workers), where an INSERT body of 40 MB exceeds a Worker's memory.
 */

import {
  INSTANCE_TYPES,
  PRICES,
  SCHEMA_VERSION,
  STAGING_DATABASE,
  SYNC_STATE,
  TABLES,
  VARIANT_COLUMNS,
  ATTRIBUTE_CHANGES,
  REGIONS,
  createTableSql,
  shardOf,
  shardsOf,
  type Column,
  type Table,
} from "@infrawrench/server-core/aws-pricing-warehouse/schema";
import { locationName } from "@infrawrench/server-core/aws-pricing-warehouse/regions";

import type { InstanceValue, Tables } from "./format";

// ---------------------------------------------------------------------------
// HTTP client

export interface ClickHouseConfig {
  /** e.g. `https://instances-clickhouse.infrawrench.com/`. */
  url: string;
  /** A bearer token that can write. */
  token: string;
  fetch?: typeof fetch;
}

/** The few calls the loader makes over ClickHouse's HTTP interface. */
export class ClickHouseHttp {
  private readonly fetch: typeof fetch;

  constructor(private readonly config: ClickHouseConfig) {
    this.fetch = config.fetch ?? fetch;
  }

  /** Run a statement; its output, as text. */
  async exec(sql: string): Promise<string> {
    return this.send(new URL(this.config.url), sql);
  }

  /** Rows of a SELECT, parsed from JSONEachRow. */
  async rows<T>(sql: string): Promise<T[]> {
    const url = new URL(this.config.url);
    url.searchParams.set("default_format", "JSONEachRow");
    const text = await this.send(url, sql);
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as T);
  }

  async insert(table: string, columns: readonly Column[], body: Uint8Array): Promise<void> {
    const url = new URL(this.config.url);
    url.searchParams.set(
      "query",
      `INSERT INTO ${table} (${columns.map((c) => c.name).join(", ")}) FORMAT RowBinary`,
    );
    await this.send(url, body);
  }

  private async send(url: URL, body: string | Uint8Array): Promise<string> {
    // Gateway errors (an isolate that ran out of memory or CPU, which
    // Cloudflare answers with its own HTML page) are worth a few more tries;
    // a ClickHouse exception is not.
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${this.config.token}` },
          body: typeof body === "string" ? body : new Uint8Array(body),
          // Long enough for a partition swap of the largest bundle; a request
          // that outlives it has hung, and the run should fail, not stall.
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        // A request that ran out its whole timeout has hung; another would too.
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        if (!timedOut && attempt < RETRIES) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw error;
      }
      const text = await res.text();
      if (res.ok) return text;
      if (isTransient(res.status, text) && attempt < RETRIES) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`ClickHouse: HTTP ${res.status}: ${summarize(text)}`);
    }
  }
}

const RETRIES = 4;
const REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

/** Cloudflare's own error pages and codes, rather than a ClickHouse exception. */
export function isTransient(status: number, body: string): boolean {
  if (status === 429 || status >= 502) return true;
  return /^error code: \d+/.test(body) || /^\s*<!DOCTYPE html/i.test(body);
}

/** A ClickHouse message as is; a Cloudflare HTML page reduced to its title. */
function summarize(body: string): string {
  const title = /<title>([^<]*)<\/title>/i.exec(body)?.[1];
  return (title ?? body).slice(0, 500).trim();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// RowBinary

/** A growable buffer of RowBinary-encoded rows. */
export class RowBinary {
  private buf = new Uint8Array(1 << 20);
  private view = new DataView(this.buf.buffer);
  length = 0;
  rows = 0;
  private readonly encoder = new TextEncoder();

  bytes(): Uint8Array {
    return this.buf.subarray(0, this.length);
  }

  reset(): void {
    this.length = 0;
    this.rows = 0;
  }

  /** Append one row, in the table's column order. */
  row(columns: readonly Column[], values: Record<string, unknown>): void {
    for (const column of columns) this.value(column, values[column.name]);
    this.rows++;
  }

  private value(column: Column, v: unknown): void {
    const nullable = column.type.startsWith("Nullable(");
    if (nullable) {
      if (v === null || v === undefined) {
        this.u8(1);
        return;
      }
      this.u8(0);
    }
    switch (column.type) {
      case "String":
      case "LowCardinality(String)":
      case "Nullable(String)":
        this.string(typeof v === "string" ? v : "");
        return;
      case "Float64":
      case "Nullable(Float64)":
        this.ensure(8);
        this.view.setFloat64(this.length, typeof v === "number" ? v : 0, true);
        this.length += 8;
        return;
      case "UInt32":
      case "Nullable(UInt32)":
      case "DateTime":
      case "Nullable(DateTime)":
        this.ensure(4);
        this.view.setUint32(
          this.length,
          typeof v === "number" ? Math.max(0, Math.floor(v)) : 0,
          true,
        );
        this.length += 4;
        return;
      case "UInt64":
        this.ensure(8);
        this.view.setBigUint64(
          this.length,
          BigInt(typeof v === "number" ? Math.floor(v) : 0),
          true,
        );
        this.length += 8;
        return;
      case "Bool":
        this.u8(v ? 1 : 0);
        return;
      case "Map(String, String)": {
        const entries = Object.entries((v ?? {}) as Record<string, string>);
        this.varint(entries.length);
        for (const [key, value] of entries) {
          this.string(key);
          this.string(value);
        }
        return;
      }
    }
  }

  private u8(b: number): void {
    this.ensure(1);
    this.buf[this.length++] = b;
  }

  private varint(n: number): void {
    this.ensure(10);
    while (n >= 0x80) {
      this.buf[this.length++] = (n & 0x7f) | 0x80;
      n = Math.floor(n / 128);
    }
    this.buf[this.length++] = n;
  }

  private string(s: string): void {
    // At most three bytes per UTF-16 unit.
    this.ensure(10 + s.length * 3);
    // Reserve the length prefix after writing, since the byte length is only
    // known then; strings here are short, so this costs one copy at most.
    const start = this.length;
    const { written } = this.encoder.encodeInto(s, this.buf.subarray(start + 5));
    const lengthBytes = varintSize(written);
    if (lengthBytes !== 5) this.buf.copyWithin(start + lengthBytes, start + 5, start + 5 + written);
    this.length = start;
    this.varint(written);
    this.length += written;
  }

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.buf.subarray(0, this.length));
    this.buf = grown;
    this.view = new DataView(grown.buffer);
  }
}

function varintSize(n: number): number {
  let size = 1;
  while (n >= 0x80) {
    n = Math.floor(n / 128);
    size++;
  }
  return size;
}

// ---------------------------------------------------------------------------
// Rows

/** The specs that `prices` repeats on every row. */
export interface Specs {
  family: string;
  size: string;
  architecture: string;
  vcpu: number | null;
  memory_gib: number | null;
  gpus: number | null;
}

type Row = Record<string, unknown>;

export interface InstanceRows {
  prices: Row[];
  instanceType: Row | null;
  attributeChanges: Row[];
  /** Region code to `[location, locationType]`, for every location the rows use. */
  regions: Map<string, [string, string]>;
}

const SIZE = /^(nano|micro|small|medium|large|\d*xlarge|metal(?:-\d+xl)?|host)(-.+)?$/;

/** A RunPod CPU pod id: flavor, vCPUs, GB of memory (`cpu3c-2-4`). */
const RUNPOD_CPU_POD = /^(cpu\d+[a-z]*)-(\d+-\d+)$/;

/**
 * An Azure VM size: `Standard_` (or `Basic_`), then the family letters, vCPUs,
 * constrained vCPUs and feature letters (`D2s`, `E64-16as`, `M176-88bds`,
 * `M176ds-44`), then any spacer parts (`A100`, `xl`), the version (`v5`) and
 * a suffix (`Promo`). Azure's own sizes page describes the scheme.
 */
const AZURE_SIZE = /^([A-Z]+)(\d+)(?:-(\d+))?([a-z]*)(?:-(\d+))?$/;

export interface AzureSize {
  /** `D`, `NC`, `FX`. */
  letters: string;
  /** Feature letters, `s`, `ads`, `pls`. */
  features: string;
  /** The series as Azure writes it: `Dsv3`, `Easv5`, `NCads_H100_v5`. */
  series: string;
  /** vCPUs, with constrained vCPUs after a dash: `2`, `64-16`. */
  size: string;
  /** The version number (`5`), or `''` for a first version. */
  version: string;
  /** Anything after the version, such as `Promo`. */
  suffix: string;
}

/** `Standard_D2s_v3` as its parts; null for names outside the scheme (`SPOT_Plus_Usage`). */
export function parseAzureSize(name: string): AzureSize | null {
  const parts = name.trim().split("_");
  if (parts.length < 2 || (parts[0] !== "Standard" && parts[0] !== "Basic")) return null;
  const head = AZURE_SIZE.exec(parts[1]!);
  if (!head) return null;
  const rest = parts.slice(2);
  const v = rest.findIndex((p) => /^v\d+$/.test(p));
  const middle = v < 0 ? rest : rest.slice(0, v);
  const version = v < 0 ? "" : rest[v]!.slice(1);
  const suffix = v < 0 ? "" : rest.slice(v + 1).join("_");
  const constrained = head[3] ?? head[5];
  const base = `${head[1]}${head[4]}`;
  return {
    letters: head[1]!,
    features: head[4]!,
    series:
      middle.length > 0
        ? `${base}_${middle.join("_")}${version ? `_v${version}` : ""}`
        : `${base}${version ? `v${version}` : ""}`,
    size: constrained ? `${head[2]}-${constrained}` : head[2]!,
    version,
    suffix,
  };
}

/**
 * A Google Cloud machine type: series, type and vCPUs (`n2-standard-2`), GPU
 * count for accelerator types (`a2-highgpu-1g`), a shared-core size
 * (`e2-micro`), and any suffix (`c3-standard-4-lssd`).
 */
const GCP_MACHINE_TYPE =
  /^([a-z]{1,2}\d+[a-z]*)-(?:([a-z][a-z0-9]*)-)?(\d+g?|micro|small|medium)(-.+)?$/;

/** `n2` and `standard-2` from `n2-standard-2`; null when it does not parse. */
export function parseGcpMachineType(
  name: string,
): { series: string; type: string; size: string; suffix: string } | null {
  if (name.includes(".")) return null;
  const match = GCP_MACHINE_TYPE.exec(name);
  if (!match) return null;
  return {
    series: match[1]!,
    type: match[2] ?? "",
    size: match[3]!,
    suffix: match[4]?.slice(1) ?? "",
  };
}

/** A Hetzner server type: its line, then two digits (`cx` and `23` from `cx23`). */
const HETZNER_SERVER = /^([a-z]+)(\d+)$/;
/** An OVHcloud eco server: year and range, number, maybe a letter (`24sys` and `01` from `24sys01`, `25sk` and `60` from `25sk60b`). */
const OVH_ECO_SERVER = /^(\d{2}[a-z]+?)(\d+)[a-z]?(?:-.+)?$/;
/** An Oracle shape: a flexible size as `<shape>-<ocpus>-<GB>`, or a fixed shape ending in its OCPUs (`VM.Standard2.4`). */
const ORACLE_SHAPE = /^((?:VM|BM)\..+?)(?:-(\d+(?:\.\d+)?-\d+(?:\.\d+)?)|\.(\d+))$/;
/** An IBM Cloud profile: family, then vCPUs, memory and any GPUs (`gx3` and `16x80x1l4` from `gx3-16x80x1l4`). */
const IBM_PROFILE = /^([a-z0-9]+)-(\d+x\d+.*)$/;

/**
 * `m7g` and `large` from `db.m7g.large` (and `ecs.g7.large`); the same rule as
 * instances' `lib/names.ts`. A RunPod CPU pod is its flavor and `<vcpu>-<gb>`
 * (`cpu3c` and `2-4` from `cpu3c-2-4`); a RunPod GPU type has neither. An
 * Azure size is its series and vCPUs (`Dsv3` and `2` from `Standard_D2s_v3`),
 * a Google Cloud machine type its series and the rest (`n2` and `standard-2`
 * from `n2-standard-2`). `platform` picks the scheme for the other clouds.
 * Hetzner, OVHcloud, Oracle and IBM have their own schemes, below.
 */
export function familyAndSize(name: string, platform = ""): { family: string; size: string } {
  if (platform === "azure") {
    const azure = parseAzureSize(name);
    return azure ? { family: azure.series, size: azure.size } : { family: "", size: "" };
  }
  if (platform === "gcp") {
    const gcp = parseGcpMachineType(name);
    if (!gcp) return { family: "", size: "" };
    const size = [gcp.type, gcp.size, gcp.suffix].filter(Boolean).join("-");
    return { family: gcp.series, size };
  }
  if (platform === "hetzner") {
    const server = HETZNER_SERVER.exec(name);
    return server ? { family: server[1]!, size: server[2]! } : { family: "", size: "" };
  }
  // A listing is one server, with no family.
  if (platform === "hetznerauction") return { family: "", size: "" };
  if (platform === "ovh") {
    // The size is after the last hyphen (`t1-le` and `45` from `t1-le-45`).
    const i = name.lastIndexOf("-");
    return i > 0
      ? { family: name.slice(0, i), size: name.slice(i + 1) }
      : { family: name, size: "" };
  }
  if (platform === "ovheco") {
    const server = OVH_ECO_SERVER.exec(name);
    return server ? { family: server[1]!, size: server[2]! } : { family: "", size: "" };
  }
  if (platform === "oracle") {
    const shape = ORACLE_SHAPE.exec(name);
    return shape ? { family: shape[1]!, size: shape[2] ?? shape[3]! } : { family: name, size: "" };
  }
  if (platform === "ibm") {
    const profile = IBM_PROFILE.exec(name);
    return profile ? { family: profile[1]!, size: profile[2]! } : { family: "", size: "" };
  }
  const pod = RUNPOD_CPU_POD.exec(name);
  if (pod) return { family: pod[1]!, size: pod[2]! };
  const tokens = name.split(".");
  for (let i = 1; i < tokens.length; i++) {
    const match = SIZE.exec(tokens[i]!);
    if (match) return { family: tokens[i - 1]!, size: match[1]! };
  }
  return { family: "", size: "" };
}

/** The first number in an attribute value (`8 GiB`, `1,952 GiB`, `Up to 3.5 GHz`), or null. */
export function number(value: string | undefined): number | null {
  if (!value) return null;
  const match = /\d[\d,]*(?:\.\d+)?|\.\d+/.exec(value);
  if (!match) return null;
  const n = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** `Up to 12500 Megabit` is 12.5, `25 Gigabit` 25, `Moderate` null. */
export function networkGbps(value: string | undefined): number | null {
  if (!value) return null;
  const match = /([\d.,]+)\s*(gigabit|gbps|megabit|mbps)/i.exec(value);
  if (!match) return null;
  const n = Number(match[1]!.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return /^m/i.test(match[2]!) ? n / 1000 : n;
}

/** Platforms that are not AWS: their attributes use their provider's own keys. */
const OTHER_CLOUDS = new Set([
  "runpod",
  "alibaba",
  "azure",
  "gcp",
  "hetzner",
  "hetznerauction",
  "ovh",
  "ovheco",
  "oracle",
  "ibm",
]);

/**
 * `arm64` or `x86_64` from what the provider lists. Alibaba says it outright
 * (`CpuArchitecture`: `X86` or `ARM`). Otherwise the processor names it when
 * there is one, and failing that the family does, by AWS's naming rule that a
 * `g` after the generation number means Graviton (`m7g`, `r6gd`, `c7gn`,
 * `x2gd`, `t4g`). The rule is AWS's, so `platform` other than an AWS one
 * skips it (Alibaba's `g7` is general purpose, not ARM).
 */
export function architectureOf(
  attrs: Record<string, string>,
  family: string,
  platform = "ec2",
): string {
  const cpuArchitecture = attrs["CpuArchitecture"] ?? attrs["architecture"];
  if (cpuArchitecture)
    return /arm/i.test(cpuArchitecture) ? "arm64" : /x86/i.test(cpuArchitecture) ? "x86_64" : "";
  // Azure marks Arm sizes (Cobalt, Ampere) with a `p` feature letter; the rest are x86.
  // `family` is the series (`Dpsv5`): its lower case letters are the features.
  if (platform === "azure") {
    if (!family) return "";
    return /^[A-Z]+[a-z]*p/.test(family) ? "arm64" : "x86_64";
  }
  // Google lists `architecture` on every series since Arm arrived; the older ones are x86.
  if (platform === "gcp") return family ? "x86_64" : "";
  // IBM's other architecture is s390x, which the column has no value for.
  if (platform === "ibm") return attrs["vcpu_architecture"] === "amd64" ? "x86_64" : "";
  // Only Oracle's A-series Standard shapes are Arm; `VM.GPU.A10.1`'s A10 is its GPU.
  if (platform === "oracle") {
    return /^[VB]M\.Standard\.A\d/.test(family) ? "arm64" : family ? "x86_64" : "";
  }
  // OVHcloud's flavors and eco servers are all x86.
  if (platform === "ovh" || platform === "ovheco") return "x86_64";
  if (platform === "hetznerauction") {
    return /ampere/i.test(attrs["CPU.Name"] ?? "") ? "arm64" : "x86_64";
  }
  const processor = `${attrs["physicalProcessor"] ?? ""} ${attrs["physicalCpu"] ?? ""} ${attrs["PhysicalProcessorModel"] ?? ""}`;
  if (OTHER_CLOUDS.has(platform)) {
    if (/ampere|yitian|\barm/i.test(processor)) return "arm64";
    if (/intel|amd|xeon|epyc|hygon/i.test(processor)) return "x86_64";
    return "";
  }
  const declared = attrs["processorArchitecture"] ?? "";
  if (/graviton|arm|apple m\d/i.test(processor) || /arm/i.test(declared)) return "arm64";
  if (/intel|amd|xeon|epyc|core i\d|apple.*intel/i.test(processor)) return "x86_64";
  const suffix = /^[a-z]+\d+([a-z-]*)$/.exec(family)?.[1];
  if (suffix !== undefined && suffix.split("-")[0]!.includes("g")) return "arm64";
  if (suffix !== undefined && /\d/.test(family) && declared.includes("64")) return "x86_64";
  return "";
}

/** A RunPod GPU type (priced per GPU), as opposed to a CPU pod. */
const isRunpodGpu = (platform: string, attrs: Record<string, string>) =>
  platform === "runpod" && attrs["productFamily"] === "GPU";

/**
 * Specs from an instance's current attributes, under whichever keys the
 * platform uses: AWS's (`vcpu`, `memory`, `gpu`), Alibaba's (`CpuCoreCount`,
 * `MemorySize`, `GPUAmount`), Azure's pricing calculator's (`cores`, `ram` in
 * GiB, `gpu` as `8x H100`), Google Cloud's Compute Engine API's (`guestCpus`,
 * `memoryMb`, `acceleratorCount`) or RunPod's. A RunPod GPU type is one GPU
 * (its prices are per GPU) and its `memoryInGb` is the GPU's memory, so it has
 * no vCPUs or memory of its own; a CPU pod's `memoryInGb` is its RAM.
 */
export function specsOf(name: string, attrs: Record<string, string>, platform = "ec2"): Specs {
  const { family, size } = familyAndSize(name, platform);
  if (isRunpodGpu(platform, attrs)) {
    return { family, size, architecture: "", vcpu: null, memory_gib: null, gpus: 1 };
  }
  const gpus = number(
    attrs["gpu"] ??
      attrs["GPUAmount"] ??
      attrs["acceleratorCount"] ??
      attrs["gpu.number"] ??
      attrs["gpuCount"] ??
      attrs["gpu_count"],
  );
  const memoryMb = number(attrs["memoryMb"]);
  // Oracle prices by OCPU: two vCPUs, or one on its A1 Arm shapes.
  if (platform === "oracle") {
    const ocpus = number(attrs["ocpus"]);
    return {
      family,
      size,
      architecture: architectureOf(attrs, family, platform),
      vcpu: ocpus === null ? null : ocpus * (/^[VB]M\.Standard\.A1/.test(family) ? 1 : 2),
      memory_gib: number(attrs["memoryInGb"]),
      gpus: gpus === null || gpus === 0 ? null : gpus,
    };
  }
  // An eco server's threads, per CPU. Its memory is the buyer's choice: it is in each price's `variant`.
  if (platform === "ovheco") {
    const threads = number(attrs["cpu.threads"]);
    return {
      family,
      size,
      architecture: architectureOf(attrs, family, platform),
      vcpu: threads === null ? null : threads * (number(attrs["cpu.number"]) ?? 1),
      memory_gib: null,
      gpus: gpus === null || gpus === 0 ? null : gpus,
    };
  }
  return {
    family,
    size,
    architecture: architectureOf(attrs, family, platform),
    vcpu: number(
      attrs["vcpu"] ??
        attrs["vCpu"] ??
        attrs["CpuCoreCount"] ??
        attrs["cores"] ??
        attrs["guestCpus"] ??
        attrs["cpu.cores"] ??
        attrs["cpu"],
    ),
    memory_gib:
      memoryMb !== null
        ? memoryMb / 1024
        : number(
            attrs["memory"] ??
              attrs["memoryGib"] ??
              attrs["MemorySize"] ??
              attrs["memoryInGb"] ??
              attrs["ram"] ??
              attrs["memory.size"] ??
              attrs["RAM.Size"],
          ),
    gpus: gpus === null || gpus === 0 ? null : gpus,
  };
}

/** Azure's size families by their letters, as its sizes overview groups them; anything else is `''`. */
const AZURE_CATEGORIES: readonly [RegExp, string][] = [
  [/^N[CDGV]/, "GPU accelerated"],
  [/^NP/, "FPGA accelerated"],
  [/^H/, "High performance compute"],
  [/^L/, "Storage optimized"],
  // G and GS are the retired G-series; DS the older premium-storage D sizes (`DS1_v2`).
  [/^(E|EC|M|G|GS)$/, "Memory optimized"],
  [/^(F|FX)$/, "Compute optimized"],
  [/^(A|B|D|DC|DS)$/, "General purpose"],
];

/** Google Cloud's machine families by series, from its machine families guide. */
const GCP_CATEGORIES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    [
      "n4",
      "n4a",
      "n4d",
      "n2",
      "n2d",
      "n1",
      "c4",
      "c4a",
      "c4d",
      "c3",
      "c3d",
      "e2",
      "t2d",
      "t2a",
      "f1",
      "g1",
    ].map((s) => [s, "General-purpose"]),
  ),
  ...Object.fromEntries(["h4d", "h3", "c2", "c2d"].map((s) => [s, "Compute-optimized"])),
  ...Object.fromEntries(
    ["x5", "x4", "m4n", "m4", "m3", "m2", "m1"].map((s) => [s, "Memory-optimized"]),
  ),
  ...Object.fromEntries(["z3", "z4d", "z4m"].map((s) => [s, "Storage-optimized"])),
  c4n: "Network-optimized",
  ...Object.fromEntries(
    ["a4x", "a4", "a3", "a2", "g4", "g2"].map((s) => [s, "Accelerator-optimized"]),
  ),
};

/** The `instance_types` columns beyond {@link Specs}, by the platform's attribute keys. */
function detailsOf(platform: string, name: string, attrs: Record<string, string>) {
  if (platform === "runpod") {
    const gpu = attrs["productFamily"] === "GPU";
    return {
      gpu_memory_gib: gpu ? number(attrs["memoryInGb"]) : null,
      gpu_model: gpu ? usable(attrs["displayName"]) : "",
      processor: "",
      clock_speed_ghz: null,
      network_performance: "",
      network_gbps: null,
      storage: "",
      // A CPU pod's flavor name (`Compute-Optimized`); `GPU` for a GPU type.
      category: gpu ? "GPU" : usable(attrs["displayName"]),
      current_generation: true,
    };
  }
  if (platform === "alibaba") {
    const rx = number(attrs["InstanceBandwidthRx"]);
    const disks = number(attrs["LocalStorageAmount"]);
    const capacity = number(attrs["LocalStorageCapacity"]);
    return {
      // GPUMemorySize is per GPU.
      gpu_memory_gib: (() => {
        const per = number(attrs["GPUMemorySize"]);
        const count = number(attrs["GPUAmount"]);
        return per === null ? null : per * (count || 1);
      })(),
      gpu_model: usable(attrs["GPUSpec"]),
      processor: usable(attrs["PhysicalProcessorModel"]),
      clock_speed_ghz: number(attrs["CpuSpeedFrequency"]),
      network_performance: rx === null ? "" : `${rx / 1_000_000} Gbit/s`,
      network_gbps: rx === null ? null : rx / 1_000_000,
      storage:
        disks && capacity
          ? `${disks} x ${capacity} GiB ${attrs["LocalStorageCategory"] ?? ""}`.trim()
          : "",
      category: usable(attrs["InstanceCategory"]),
      current_generation: true,
    };
  }
  if (platform === "azure") {
    const size = parseAzureSize(name);
    const disk = number(attrs["diskSize"]);
    return {
      gpu_memory_gib: null,
      // `8x H100`, `1X T4`.
      gpu_model: usable(attrs["gpu"]?.replace(/^\s*\d+\s*x\s*/i, "")),
      processor: "",
      clock_speed_ghz: null,
      network_performance: "",
      network_gbps: null,
      storage: disk ? `${disk} GiB temporary disk` : "",
      category: size
        ? (AZURE_CATEGORIES.find(([letters]) => letters.test(size.letters))?.[1] ?? "")
        : "",
      current_generation: true,
    };
  }
  if (platform === "gcp") {
    const series = parseGcpMachineType(name)?.series ?? "";
    const accelerator = attrs["acceleratorType"] ?? "";
    // The type names its memory when it varies (`nvidia-h100-80gb`); per GPU.
    const perGpu = number(/(\d+)gb\b/i.exec(accelerator)?.[1]);
    const count = number(attrs["acceleratorCount"]);
    const ssds = number(attrs["bundledLocalSsds.partitionCount"]);
    return {
      gpu_memory_gib: perGpu !== null && count ? perGpu * count : null,
      gpu_model: accelerator,
      processor: "",
      clock_speed_ghz: null,
      network_performance: "",
      network_gbps: null,
      storage: ssds ? `${ssds} x Local SSD` : "",
      category: GCP_CATEGORIES[series] ?? "",
      current_generation: attrs["deprecated"] === undefined,
    };
  }
  if (platform === "hetzner") {
    return {
      gpu_memory_gib: null,
      gpu_model: "",
      processor: usable(attrs["cpu"]),
      clock_speed_ghz: null,
      network_performance: "",
      network_gbps: null,
      storage: attrs["diskInGb"] ? `${attrs["diskInGb"]} GB ${attrs["diskType"] ?? ""}`.trim() : "",
      category: usable(attrs["category"]),
      current_generation: true,
    };
  }
  if (platform === "hetznerauction") {
    const mbit = number(attrs["Bandwidth"]);
    return {
      gpu_memory_gib: null,
      gpu_model: "",
      processor: usable(attrs["CPU.Name"]),
      clock_speed_ghz: null,
      network_performance: mbit === null ? "" : `${mbit / 1000} Gbit/s`,
      network_gbps: mbit === null ? null : mbit / 1000,
      storage: usable(attrs["Information"]),
      category: "Server Auction",
      current_generation: true,
    };
  }
  if (platform === "ovh") {
    const mbit = number(attrs["bandwidth.level"]);
    const perGpu = number(attrs["gpu.memory.size"]);
    const count = number(attrs["gpu.number"]);
    return {
      gpu_memory_gib: perGpu !== null && count ? perGpu * count : null,
      gpu_model: usable(attrs["gpu.model"]),
      processor: "",
      clock_speed_ghz: number(attrs["cpu.frequency"]),
      network_performance: mbit === null ? "" : `${mbit / 1000} Gbit/s`,
      network_gbps: mbit === null ? null : mbit / 1000,
      storage: usable(attrs["storage.disks"]),
      category: usable(attrs["brick"]),
      current_generation: true,
    };
  }
  if (platform === "ovheco") {
    return {
      gpu_memory_gib: null,
      gpu_model: "",
      processor: [attrs["cpu.brand"], attrs["cpu.model"]].filter(Boolean).join(" "),
      clock_speed_ghz: number(attrs["cpu.frequency"]),
      network_performance: "",
      network_gbps: null,
      // The buyer's choice: it is in each price's `variant`.
      storage: "",
      category: usable(attrs["range"]),
      current_generation: true,
    };
  }
  if (platform === "oracle") {
    const processor = /Processor: ([^.]+)/.exec(attrs["description"] ?? "")?.[1];
    return {
      gpu_memory_gib: number(attrs["gpuMemoryInGb"]),
      gpu_model: "",
      processor: usable(processor),
      clock_speed_ghz: null,
      network_performance: "",
      network_gbps: null,
      storage: usable(attrs["localDisk"]),
      // The shape's second part: `Standard`, `DenseIO`, `GPU`, `Optimized3`.
      category: name.split(".")[1] ?? "",
      current_generation: true,
    };
  }
  if (platform === "ibm") {
    const mbit = number(attrs["bandwidth"]);
    const perGpu = number(attrs["gpu_memory"]);
    const count = number(attrs["gpu_count"]);
    const mhz = number(attrs["freqency"]); // IBM's spelling
    return {
      gpu_memory_gib: perGpu !== null && count ? perGpu * count : null,
      gpu_model: usable(attrs["gpu_model"]),
      processor: usable(attrs["vcpu_manufacturer"]),
      clock_speed_ghz: mhz === null ? null : mhz / 1000,
      network_performance: mbit === null ? "" : `${mbit / 1000} Gbit/s`,
      network_gbps: mbit === null ? null : mbit / 1000,
      storage: usable(attrs["disks"]),
      category: usable(attrs["family"]),
      current_generation: attrs["status"] === undefined || attrs["status"] === "current",
    };
  }
  return {
    gpu_memory_gib: number(attrs["gpuMemory"]),
    gpu_model: usable(attrs["physicalGpu"] ?? attrs["gpuModel"]),
    processor: usable(attrs["physicalProcessor"] ?? attrs["physicalCpu"]),
    clock_speed_ghz: number(attrs["clockSpeed"]),
    network_performance: usable(attrs["networkPerformance"]),
    network_gbps: networkGbps(attrs["networkPerformance"]),
    storage: usable(attrs["storage"] ?? attrs["instanceStorage"]),
    category: usable(attrs["instanceFamily"] ?? attrs["computeType"]),
    current_generation: (attrs["currentGeneration"] ?? "Yes") !== "No",
  };
}

const EMPTY_SPECS = (name: string): Specs => ({
  ...familyAndSize(name),
  architecture: "",
  vcpu: null,
  memory_gib: null,
  gpus: null,
});

const HOURS_PER_YEAR = 8760;
const HOURS_PER_MONTH = 730;

/** A term's length in hours: `1yr` to `5yr`, or months (`1mo`, `3mo`, `6mo`); a year when unreadable. */
export function leaseHours(lease: string): number {
  const match = /^(\d+)\s*(yr|mo)/.exec(lease);
  if (!match) return HOURS_PER_YEAR;
  return Number(match[1]) * (match[2] === "mo" ? HOURS_PER_MONTH : HOURS_PER_YEAR);
}

interface Period {
  key: string;
  base: Row;
  from: number;
  hourly: number;
  upfront: number;
}

/**
 * One instance's rows. `pricing` is `on_demand` for platform bundles, whose
 * reserved rows are `reserved`, and `spot` for the spot bundle, which stores
 * spot prices as on-demand rows. `specFor` supplies specs for a bundle that
 * has no attributes (spot).
 */
export function instanceRows(
  value: InstanceValue,
  source: string,
  options: { specFor?: ((name: string) => Specs | undefined) | undefined } = {},
): InstanceRows {
  const strings = value.compression_table;
  const str = (i: unknown): string => {
    const s = typeof i === "number" ? strings[i] : undefined;
    if (s === undefined) throw new Error(`${value.name}: string ${String(i)} out of range`);
    return s;
  };
  const platform = source === "spot" ? "ec2" : value.platform;
  const spot = source === "spot";

  // Locations, by string index. The bundle's regions table only lists
  // locations with attributes; anything else is named by its string (spot's
  // locations are codes already).
  const regions = new Map<string, [string, string]>();
  const located = new Map<number, string>();
  for (const [loc, pairs] of value.regions) {
    const attrs = Object.fromEntries(pairs.map(([k, v]) => [str(k), str(v)]));
    const location = str(loc);
    const code = attrs["regionCode"] || location;
    located.set(loc, code);
    // Alibaba's and Azure's locations are region ids, with the English name
    // in `name`; Google Cloud's have no name, so it comes from a table.
    regions.set(code, [locationName(platform, location, attrs), attrs["locationType"] ?? ""]);
  }
  const regionOf = (loc: unknown): string => {
    const known = located.get(loc as number);
    if (known !== undefined) return known;
    const name = str(loc);
    located.set(loc as number, name);
    if (!regions.has(name)) regions.set(name, [name, ""]);
    return name;
  };

  const [attrPairs, changes, basePrice, od, rs, createdAt, deletedAt] = value.instance as [
    [number, number][],
    (number | null)[][],
    number,
    (number | null)[][],
    (number | null)[][],
    number,
    number | null,
  ];

  // Attributes: the first listing, then changes oldest first.
  const attrs: Record<string, string> = {};
  const attributeChanges: Row[] = [];
  for (const [k, v] of attrPairs) {
    attrs[str(k)] = str(v);
    attributeChanges.push({
      source,
      platform,
      instance_type: value.name,
      at: createdAt,
      attribute: str(k),
      value: str(v),
      region: "",
    });
  }
  const sortedChanges = [...changes].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  for (const [ts, key, val, loc] of sortedChanges) {
    const regional = loc !== null && loc !== undefined;
    const k = str(key);
    const v = val === null || val === undefined ? null : str(val);
    if (!regional) {
      if (v === null) delete attrs[k];
      else attrs[k] = v;
    }
    attributeChanges.push({
      source,
      platform,
      instance_type: value.name,
      at: ts,
      attribute: k,
      value: v,
      region: regional ? regionOf(loc) : "",
    });
  }

  const specs = spot
    ? (options.specFor?.(value.name) ?? EMPTY_SPECS(value.name))
    : specsOf(value.name, attrs, platform);

  const variantKeys = value.variant_keys;
  const variantColumns = value.variants.map((fields) => {
    const row: Row = {};
    const extra: Record<string, string> = {};
    fields.forEach((f, i) => {
      const key = variantKeys[i]!;
      const column = VARIANT_COLUMNS[key];
      if (column) row[column] = str(f);
      else extra[key] = str(f);
    });
    row["variant"] = extra;
    return row;
  });
  const terms = value.reserved_terms.map(([lease, offeringClass, purchaseOption]) => ({
    lease: str(lease),
    offering_class: str(offeringClass),
    purchase_option: str(purchaseOption),
  }));

  const prices: Row[] = [];
  const common = {
    source,
    shard: shardOf(source, value.name),
    platform,
    instance_type: value.name,
    ...specs,
  };
  const open = new Map<string, Period>();
  const close = (key: string, at: number) => {
    const p = open.get(key);
    if (!p) return;
    open.delete(key);
    prices.push(priceRow(p, at));
  };
  const priceRow = (p: Period, to: number | null): Row => ({
    ...p.base,
    hourly_usd: p.hourly,
    upfront_usd: p.upfront,
    effective_hourly_usd: p.hourly + effectiveUpfront(p),
    valid_from: p.from,
    valid_to: to,
    current: to === null,
  });
  const effectiveUpfront = (p: Period): number => {
    if (!p.upfront) return 0;
    return p.upfront / leaseHours(String(p.base["lease"]));
  };

  // [ts, location, variant, price?]: omitted is the base price, null is no
  // longer offered, and $0 on demand means AWS has no capacity to sell
  // (instances' decodeInstance reads it the same way).
  type Event = { at: number; key: string; base: Row; hourly: number | null; upfront: number };
  const events: Event[] = [];
  for (const [ts, loc, variant, ...price] of od) {
    const region = regionOf(loc);
    const hourly = price.length === 0 ? basePrice : (price[0] ?? null);
    events.push({
      at: ts!,
      key: `o|${region}|${variant}`,
      base: {
        ...common,
        region,
        pricing: spot ? "spot" : "on_demand",
        lease: "",
        offering_class: "",
        purchase_option: "",
        ...variantColumns[variant!],
      },
      hourly: hourly === 0 ? null : hourly,
      upfront: 0,
    });
  }
  // [ts, location, variant, term, hourly: null = no longer offered, upfront?]
  for (const [ts, loc, variant, term, hourly, upfront] of rs) {
    const region = regionOf(loc);
    events.push({
      at: ts!,
      key: `r|${region}|${variant}|${term}`,
      base: {
        ...common,
        region,
        pricing: "reserved",
        ...terms[term!],
        ...variantColumns[variant!],
      },
      hourly: hourly === null || hourly === undefined ? null : hourly,
      upfront: upfront ?? 0,
    });
  }
  // Stable, so rows with the same timestamp keep their order (later rows win).
  events.sort((a, b) => a.at - b.at);
  for (const e of events) {
    const current = open.get(e.key);
    if (e.hourly === null) {
      close(e.key, e.at);
      continue;
    }
    if (current && current.hourly === e.hourly && current.upfront === e.upfront) continue;
    close(e.key, e.at);
    open.set(e.key, { key: e.key, base: e.base, from: e.at, hourly: e.hourly, upfront: e.upfront });
  }
  const offeredIn = new Set<string>();
  for (const [key, p] of open) {
    if (deletedAt) close(key, deletedAt);
    else {
      if (key.startsWith("o|")) offeredIn.add(String(p.base["region"]));
      prices.push(priceRow(p, null));
    }
  }

  const instanceType: Row | null = spot
    ? null
    : {
        source,
        platform,
        instance_type: value.name,
        ...specs,
        ...detailsOf(platform, value.name, attrs),
        regions_offered: offeredIn.size,
        first_listed: createdAt,
        retired_at: deletedAt ?? null,
        attributes: attrs,
      };

  return { prices, instanceType, attributeChanges, regions };
}

/** `NA`, `N/A` and blanks read as nothing. */
function usable(value: string | undefined): string {
  return !value || /^n\/?a$/i.test(value.trim()) ? "" : value;
}

// ---------------------------------------------------------------------------
// Loading

/** A batch is sent once it reaches this many bytes. */
const BATCH_BYTES = 6 * 1024 * 1024;
/** INSERTs in flight at once. */
const CONCURRENCY = 4;

export interface WarehouseLoad {
  /** Add one instance; awaits when too many batches are in flight. */
  add(value: InstanceValue): Promise<void>;
  /** Swap the loaded bundle in. */
  commit(meta: { version: string; snapshots: number[] }): Promise<{ priceRows: number }>;
}

/** What the sync needs of the warehouse. */
export interface PricingWarehouse {
  /** The version each source was last loaded at; creates the tables on first use. */
  versions(): Promise<Map<string, string>>;
  begin(source: string, tables: Tables): Promise<WarehouseLoad>;
}

export class ClickHouseWarehouse implements PricingWarehouse {
  constructor(
    private readonly ch: ClickHouseHttp,
    private readonly log: (line: string) => void = console.log,
  ) {}

  async versions(): Promise<Map<string, string>> {
    await this.ensureSchema();
    const rows = await this.ch.rows<{ source: string; version: string }>(
      `SELECT source, argMax(version, synced_at) AS version FROM ${SYNC_STATE.name} WHERE schema_version = ${SCHEMA_VERSION} GROUP BY source`,
    );
    return new Map(rows.map((r) => [r.source, r.version]));
  }

  /**
   * Create the tables, or recreate them all when the schema version moved
   * (the next loads then reload every bundle, since `sync_state` is empty).
   */
  private async ensureSchema(): Promise<void> {
    const existing = await this.ch
      .rows<{ version: number | string }>(
        `SELECT max(schema_version) AS version FROM ${SYNC_STATE.name}`,
      )
      .catch(() => null);
    // 0 is an empty table: nothing loaded yet, nothing to recreate.
    const loaded = Number(existing?.[0]?.version ?? 0);
    const stale = loaded !== 0 && loaded !== SCHEMA_VERSION;
    await this.ch.exec(`CREATE DATABASE IF NOT EXISTS ${STAGING_DATABASE}`);
    for (const table of TABLES) {
      if (stale) {
        this.log(`warehouse: schema ${loaded} -> ${SCHEMA_VERSION}, recreating ${table.name}`);
        await this.ch.exec(`DROP TABLE IF EXISTS ${table.name}`);
        await this.ch.exec(`DROP TABLE IF EXISTS ${STAGING_DATABASE}.${table.name}`);
      }
      await this.ch.exec(createTableSql(table));
      await this.ch.exec(createTableSql(table, STAGING_DATABASE));
    }
  }

  async begin(source: string): Promise<WarehouseLoad> {
    for (const table of TABLES)
      await this.ch.exec(`TRUNCATE TABLE ${STAGING_DATABASE}.${table.name}`);
    let specFor: ((name: string) => Specs | undefined) | undefined;
    if (source === "spot") {
      // Spot bundles carry no attributes; take EC2's.
      const rows = await this.ch.rows<Specs & { instance_type: string }>(
        `SELECT instance_type, family, size, architecture, vcpu, memory_gib, gpus FROM ${INSTANCE_TYPES.name} WHERE platform = 'ec2'`,
      );
      const byName = new Map(rows.map((r) => [r.instance_type, r]));
      specFor = (name) => {
        const r = byName.get(name);
        if (!r) return undefined;
        return {
          family: r.family,
          size: r.size,
          architecture: r.architecture,
          vcpu: r.vcpu === null ? null : Number(r.vcpu),
          memory_gib: r.memory_gib === null ? null : Number(r.memory_gib),
          gpus: r.gpus === null ? null : Number(r.gpus),
        };
      };
    }
    return new ClickHouseLoad(this.ch, source, specFor, this.log);
  }
}

class ClickHouseLoad implements WarehouseLoad {
  private readonly buffers = new Map<Table, RowBinary>();
  private readonly sent = new Map<Table, number>();
  /** `prices` rows per shard, to know which partitions to swap and which to drop. */
  private readonly shardRows = new Map<string, number>();
  private readonly inFlight = new Set<Promise<void>>();
  private failure: unknown = null;
  private readonly regions = new Map<string, [string, string]>();

  constructor(
    private readonly ch: ClickHouseHttp,
    private readonly source: string,
    private readonly specFor: ((name: string) => Specs | undefined) | undefined,
    private readonly log: (line: string) => void,
  ) {
    for (const table of TABLES) {
      this.buffers.set(table, new RowBinary());
      this.sent.set(table, 0);
    }
  }

  async add(value: InstanceValue): Promise<void> {
    const rows = instanceRows(value, this.source, { specFor: this.specFor });
    for (const row of rows.prices) this.put(PRICES, row);
    if (rows.instanceType) this.put(INSTANCE_TYPES, rows.instanceType);
    for (const row of rows.attributeChanges) this.put(ATTRIBUTE_CHANGES, row);
    // Spot's locations are bare codes; the platform bundles name them.
    if (this.source !== "spot") {
      for (const [code, entry] of rows.regions) {
        // A location with a code and type beats one named only by its string.
        if (!this.regions.has(code) || entry[1]) this.regions.set(code, entry);
      }
    }
    for (const table of TABLES) {
      if (this.buffers.get(table)!.length >= BATCH_BYTES) await this.flush(table);
    }
  }

  private put(table: Table, row: Record<string, unknown>): void {
    this.buffers.get(table)!.row(table.columns, row);
    if (table === PRICES) {
      const shard = String(row["shard"]);
      this.shardRows.set(shard, (this.shardRows.get(shard) ?? 0) + 1);
    }
  }

  private async flush(table: Table): Promise<void> {
    const buffer = this.buffers.get(table)!;
    if (buffer.rows === 0) return;
    while (this.inFlight.size >= CONCURRENCY) await Promise.race(this.inFlight);
    if (this.failure) throw this.failure;
    const body = buffer.bytes().slice();
    const rows = buffer.rows;
    buffer.reset();
    const send = this.ch
      .insert(`${STAGING_DATABASE}.${table.name}`, table.columns, body)
      .then(() => {
        this.sent.set(table, this.sent.get(table)! + rows);
      })
      .catch((error: unknown) => {
        this.failure ??= error;
      })
      .finally(() => this.inFlight.delete(send));
    this.inFlight.add(send);
  }

  /**
   * This source's `prices` partitions with the rows each was sent: its shards,
   * plus any the live table has that the shard plan no longer makes (they
   * are dropped).
   */
  private async pricePartitions(): Promise<(readonly [string, number])[]> {
    const live = await this.ch.rows<{ shard: string }>(
      `SELECT DISTINCT shard FROM ${PRICES.name} WHERE source = '${this.source.replace(/[^A-Za-z0-9_-]/g, "")}'`,
    );
    const names = new Set([...shardsOf(this.source), ...live.map((r) => r.shard)]);
    return [...names].map((name) => [name, this.shardRows.get(name) ?? 0] as const);
  }

  async commit(meta: { version: string; snapshots: number[] }): Promise<{ priceRows: number }> {
    for (const [code, [location, type]] of this.regions) {
      this.put(REGIONS, { source: this.source, region: code, location, location_type: type });
    }
    const snapshots = [...meta.snapshots].sort((a, b) => a - b);
    for (const table of TABLES) {
      if (table !== SYNC_STATE) await this.flush(table);
    }
    await Promise.all(this.inFlight);
    if (this.failure) throw this.failure;

    // A retried INSERT may have landed twice; a count that disagrees fails
    // the load rather than swapping in duplicates.
    for (const table of TABLES) {
      if (table === SYNC_STATE) continue;
      const [row] = await this.ch.rows<{ n: string | number }>(
        `SELECT count() AS n FROM ${STAGING_DATABASE}.${table.name}`,
      );
      const staged = Number(row?.n ?? 0);
      if (staged !== this.sent.get(table)) {
        throw new Error(
          `warehouse ${this.source}: staged ${staged} rows in ${table.name} but sent ${this.sent.get(table)}`,
        );
      }
    }

    this.put(SYNC_STATE, {
      source: this.source,
      version: meta.version,
      schema_version: SCHEMA_VERSION,
      price_lists: snapshots.length,
      price_list_from: snapshots[0] ?? null,
      price_list_to: snapshots.at(-1) ?? null,
      synced_at: Math.floor(Date.now() / 1000),
      price_rows: this.sent.get(PRICES)!,
    });
    await this.flush(SYNC_STATE);
    await Promise.all(this.inFlight);
    if (this.failure) throw this.failure;

    // One partition at a time, sync_state last: until it moves, the next run
    // reloads this source. Readers can see some of a sharded source's new
    // shards beside old ones for the minute this takes; each row is whole.
    for (const table of TABLES) {
      const partitions =
        table === PRICES
          ? await this.pricePartitions()
          : [[this.source, this.sent.get(table)!] as const];
      for (const [partition, rows] of partitions) {
        const literal = `'${partition.replace(/[^A-Za-z0-9_-]/g, "")}'`;
        await this.ch.exec(
          rows === 0
            ? `ALTER TABLE ${table.name} DROP PARTITION ${literal}`
            : `ALTER TABLE ${table.name} REPLACE PARTITION ${literal} FROM ${STAGING_DATABASE}.${table.name}`,
        );
      }
    }
    for (const table of TABLES)
      await this.ch.exec(`TRUNCATE TABLE ${STAGING_DATABASE}.${table.name}`);
    const priceRows = this.sent.get(PRICES)!;
    this.log(
      `warehouse ${this.source}: ${priceRows} price rows, ${this.sent.get(INSTANCE_TYPES)} instance types`,
    );
    return { priceRows };
  }
}
