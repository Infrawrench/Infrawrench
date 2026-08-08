/**
 * Kubernetes resource-quantity parsing.
 *
 * `resource.Quantity` is a fixed-point number with an optional suffix. The
 * canonical grammar (k8s.io/apimachinery/pkg/api/resource/quantity.go) is:
 *
 *   <quantity>        ::= <signedNumber><suffix>
 *   <suffix>          ::= <binarySI> | <decimalSI> | <decimalExponent>
 *   <binarySI>        ::= Ki | Mi | Gi | Ti | Pi | Ei          (powers of 1024)
 *   <decimalSI>       ::= n | u | m | "" | k | M | G | T | P | E   (powers of 1000)
 *   <decimalExponent> ::= "e" <signedNumber> | "E" <signedNumber>
 *
 * Two traps this module exists to avoid:
 *
 *  - `M` is 1000^2 and `Mi` is 1024^2. Treating `512Mi` as 512e6 under-counts
 *    memory by 4.9%, and every derived cost is wrong by the same amount in the
 *    same direction, so it never looks like a bug.
 *  - kilo is lowercase `k` (`1k` = 1000). Uppercase `K` is NOT a valid decimal
 *    suffix — apimachinery rejects it — so we reject it too rather than
 *    silently guessing.
 *
 * CPU is conventionally written in "millicores" (`100m` = 0.1 CPU) but that is
 * just the `m` = 1e-3 decimal suffix; there is no CPU-specific parsing.
 */

/** Decimal (power-of-1000) suffixes, including the sub-unit ones CPU uses. */
const DECIMAL_SUFFIXES: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  "": 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

/** Binary (power-of-1024) suffixes. */
const BINARY_SUFFIXES: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};

/**
 * `<signedNumber>` followed by either a binary suffix, a decimal-exponent, or
 * a decimal suffix. Anchored, so trailing junk is a parse failure rather than
 * a silent truncation.
 */
const QUANTITY_RE = /^([+-]?(?:\d+\.?\d*|\.\d+))(Ki|Mi|Gi|Ti|Pi|Ei|[eE][+-]?\d+|[numkMGTPE])?$/;

/**
 * Parse a Kubernetes quantity into a plain number in base units (cores for
 * CPU, bytes for memory). Returns `null` for anything unparseable — callers
 * decide whether that means "zero" or "unknown", because those are different
 * things for cost attribution.
 */
export function parseQuantity(raw: string | number | undefined | null): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;

  const text = raw.trim();
  if (text === "") return null;

  const match = QUANTITY_RE.exec(text);
  if (!match) return null;

  const mantissa = Number(match[1]);
  if (!Number.isFinite(mantissa)) return null;

  const suffix = match[2] ?? "";
  if (suffix === "") return mantissa;

  if (suffix in BINARY_SUFFIXES) return mantissa * BINARY_SUFFIXES[suffix]!;

  // decimalExponent: "1e3", "1.5E-2". The length check is load-bearing: a bare
  // "E" is the exa SUFFIX (1e18), not an exponent with an empty operand, and
  // `Number("")` is 0 — so without it "1E" silently parses as 1 instead of
  // 10^18. Lowercase "e" alone never reaches here; the regex rejects it, which
  // is also what apimachinery does.
  if (suffix.length > 1 && (suffix[0] === "e" || suffix[0] === "E")) {
    const exponent = Number(suffix.slice(1));
    if (!Number.isFinite(exponent)) return null;
    return mantissa * 10 ** exponent;
  }

  const decimal = DECIMAL_SUFFIXES[suffix];
  return decimal === undefined ? null : mantissa * decimal;
}

/** Parse, treating anything unparseable or absent as 0. */
export function parseQuantityOrZero(raw: string | number | undefined | null): number {
  return parseQuantity(raw) ?? 0;
}

/** Bytes → GiB, the unit humans read memory in. */
export const BYTES_PER_GIB = 1024 ** 3;

/**
 * A CPU + memory pair in base units (cores, bytes). Used for requests,
 * limits, capacity, allocatable and live usage alike.
 */
export interface ResourcePair {
  cpuCores: number;
  memoryBytes: number;
}

export const ZERO_PAIR: ResourcePair = { cpuCores: 0, memoryBytes: 0 };

export function addPairs(a: ResourcePair, b: ResourcePair): ResourcePair {
  return { cpuCores: a.cpuCores + b.cpuCores, memoryBytes: a.memoryBytes + b.memoryBytes };
}

export function maxPairs(a: ResourcePair, b: ResourcePair): ResourcePair {
  return {
    cpuCores: Math.max(a.cpuCores, b.cpuCores),
    memoryBytes: Math.max(a.memoryBytes, b.memoryBytes),
  };
}

/** Parse a `{ cpu, memory }` map off a container's `resources.requests`/`.limits`. */
export function parseResourceMap(map: Record<string, string> | undefined): ResourcePair {
  if (!map) return ZERO_PAIR;
  return {
    cpuCores: parseQuantityOrZero(map["cpu"]),
    memoryBytes: parseQuantityOrZero(map["memory"]),
  };
}

/** Format cores compactly for a pill subtitle: `1.5` / `250m`. */
export function formatCores(cores: number): string {
  if (cores === 0) return "0";
  if (cores < 1) return `${Math.round(cores * 1000)}m`;
  return `${Number(cores.toFixed(2))}`;
}

/** Format bytes as GiB/MiB for a pill subtitle. */
export function formatMemory(bytes: number): string {
  if (bytes === 0) return "0";
  const gib = bytes / BYTES_PER_GIB;
  if (gib >= 1) return `${Number(gib.toFixed(2))}Gi`;
  return `${Math.round(bytes / 1024 ** 2)}Mi`;
}
