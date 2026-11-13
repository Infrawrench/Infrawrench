/**
 * Reading a pipeline's `cloud.gpu` for CI executors on GPU clouds. Nothing
 * here knows a provider: each plugin maps the parsed type onto its own GPU
 * names (RunPod's `NVIDIA H100 80GB HBM3`, Lambda's `gpu_1x_h100_sxm5`,
 * Paperspace's `H100x8`) with {@link ciGpuKey} and {@link ciGpuMatches}.
 */

/** `cloud.gpu`, read: the GPU type as written, and how many. */
export interface CiGpuRequest {
  /** The type as the pipeline wrote it, trimmed, e.g. `H100` or `a100-80gb`. */
  type: string;
  /** At least 1. */
  count: number;
}

/**
 * Reads `cloud.gpu`, which is `<type>[:<count>]` (`H100`, `a100-80gb:2`).
 * Throws, naming the value, when the type is empty or the count is not a
 * whole number from 1 to 64.
 */
export function parseCiGpu(gpu: string): CiGpuRequest {
  const text = gpu.trim();
  const colon = text.lastIndexOf(":");
  const type = (colon < 0 ? text : text.slice(0, colon)).trim();
  const countText = colon < 0 ? "1" : text.slice(colon + 1).trim();
  if (!type) throw new Error(`\`cloud.gpu\` names no GPU type: \`${gpu}\`.`);
  if (!/^\d+$/.test(countText) || Number(countText) < 1 || Number(countText) > 64) {
    throw new Error(
      `\`cloud.gpu\` wants a GPU count from 1 to 64 after the colon, not \`${countText}\`.`,
    );
  }
  return { type, count: Number(countText) };
}

const BRANDS = new Set(["nvidia", "amd", "geforce", "tesla"]);

/**
 * A GPU name as words for matching: lowercase letters and digits, split at
 * anything else, with brand words (`nvidia`, `amd`, `geforce`, `tesla`)
 * dropped. `NVIDIA H100 80GB HBM3` is `["h100", "80gb", "hbm3"]`.
 */
export function ciGpuWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !BRANDS.has(w));
}

/** A GPU name reduced to one key: {@link ciGpuWords} joined, e.g. `h10080gbhbm3`. */
export function ciGpuKey(name: string): string {
  return ciGpuWords(name).join("");
}

/**
 * Whether a provider's GPU name is the type a pipeline asked for: the
 * provider's name, word by word, starts with the type (spaces and dashes
 * aside). `h100` matches `NVIDIA H100 80GB HBM3` and `H100 SXM`, not
 * `H1000`; `a100-80gb` matches `A100 80GB PCIe`; `rtxa6000` matches `RTX
 * A6000`; `a10` does not match `A100`.
 */
export function ciGpuMatches(type: string, providerName: string): boolean {
  const want = ciGpuKey(type);
  if (!want) return false;
  let joined = "";
  for (const word of ciGpuWords(providerName)) {
    joined += word;
    if (joined === want) return true;
    if (joined.length >= want.length) return false;
  }
  return false;
}
