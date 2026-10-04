/**
 * GitHub billing products and SKUs.
 *
 * The identifiers are GitHub's own ("Product and SKU names" in GitHub's
 * billing reference, verified 2026-10). The usage API is documented to return
 * those identifiers, but GitHub's own examples also show friendly spellings
 * (`"Actions"`, `"Actions Linux"`), so everything coming off the wire goes
 * through {@link normalizeId} first and is compared in identifier form.
 */

/** `"Actions Linux"`, `"actions-linux"` and `"actions_linux"` all become `actions_linux`. */
export function normalizeId(raw: string | undefined): string {
  return (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Product-level identifiers, usable for `ProductPricing` budgets. */
export const PRODUCTS: Array<{ id: string; label: string }> = [
  { id: "actions", label: "Actions" },
  { id: "packages", label: "Packages" },
  { id: "codespaces", label: "Codespaces" },
  { id: "copilot", label: "Copilot" },
  { id: "ghas", label: "Advanced Security" },
  { id: "ghec", label: "Enterprise Cloud" },
  { id: "sandbox", label: "Copilot Sandboxes" },
];

/** Every SKU identifier GitHub documents, for `SkuPricing` budgets. */
export const SKUS: string[] = [
  "actions_cache_storage",
  "actions_custom_image_storage",
  "actions_linux",
  "actions_linux_16_core",
  "actions_linux_16_core_arm",
  "actions_linux_2_core_advanced",
  "actions_linux_2_core_arm",
  "actions_linux_32_core",
  "actions_linux_32_core_arm",
  "actions_linux_4_core",
  "actions_linux_4_core_arm",
  "actions_linux_4_core_gpu",
  "actions_linux_64_core",
  "actions_linux_64_core_arm",
  "actions_linux_8_core",
  "actions_linux_8_core_arm",
  "actions_linux_96_core",
  "actions_linux_arm",
  "actions_linux_slim",
  "actions_macos",
  "actions_macos_l",
  "actions_macos_xl",
  "actions_storage",
  "actions_windows",
  "actions_windows_16_core",
  "actions_windows_16_core_arm",
  "actions_windows_2_core",
  "actions_windows_2_core_advanced",
  "actions_windows_2_core_arm",
  "actions_windows_32_core",
  "actions_windows_32_core_arm",
  "actions_windows_4_core",
  "actions_windows_4_core_arm",
  "actions_windows_4_core_gpu",
  "actions_windows_64_core",
  "actions_windows_64_core_arm",
  "actions_windows_8_core",
  "actions_windows_8_core_arm",
  "actions_windows_96_core",
  "actions_windows_arm",
  "codespaces_compute_d2",
  "codespaces_compute_d4",
  "codespaces_compute_d8",
  "codespaces_compute_d16",
  "codespaces_compute_d32",
  "codespaces_prebuild_storage",
  "codespaces_storage",
  "copilot_for_business",
  "copilot_enterprise",
  "copilot_standalone",
  "copilot_ai_credit",
  "coding_agent_ai_credit",
  "premium_requests",
  "ghas_licenses",
  "ghas_code_security_licenses",
  "ghas_secret_protection_licenses",
  "code_quality_licenses",
  "code_quality_ai_credit",
  "sandbox_linux",
  "sandbox_memory",
  "sandbox_snapshot",
  "ghec_licenses",
  "git_lfs_bandwidth",
  "git_lfs_storage",
  "models_inference",
  "packages_bandwidth",
  "packages_storage",
  "spark_ai_credits",
];

const PRODUCT_LABELS: Record<string, string> = {
  ...Object.fromEntries(PRODUCTS.map((p) => [p.id, p.label])),
  git_lfs: "Git LFS",
  lfs: "Git LFS",
  github_advanced_security: "Advanced Security",
  advanced_security: "Advanced Security",
  copilot_ai_credits: "Copilot",
  ai_credits: "Copilot",
  code_quality: "Code Quality",
  models: "Models",
  spark: "Spark",
};

/** The product a cost row is filed under: the service dimension. */
export function productLabel(rawProduct: string | undefined, rawSku?: string): string {
  const product = normalizeId(rawProduct);
  const sku = normalizeId(rawSku);
  // LFS usage is reported under its own SKUs; give it a product of its own
  // rather than leaving it inside whatever product the API names.
  if (sku.startsWith("git_lfs")) return "Git LFS";
  if (product && PRODUCT_LABELS[product]) return PRODUCT_LABELS[product]!;
  if (sku.startsWith("actions_")) return "Actions";
  if (sku.startsWith("codespaces_")) return "Codespaces";
  if (sku.startsWith("packages_")) return "Packages";
  if (sku.startsWith("ghas_")) return "Advanced Security";
  if (sku.startsWith("copilot") || sku.includes("premium_request")) return "Copilot";
  return rawProduct?.trim() || "Other";
}

const WORDS: Record<string, string> = {
  macos: "macOS",
  arm: "Arm",
  gpu: "GPU",
  ghas: "Advanced Security",
  ghec: "Enterprise Cloud",
  lfs: "LFS",
  ai: "AI",
  l: "L",
  xl: "XL",
};

/** `actions_linux_4_core_arm` → "Actions Linux 4-core Arm". */
export function skuLabel(rawSku: string | undefined): string {
  const sku = normalizeId(rawSku);
  if (!sku) return "";
  if (sku === "copilot_for_business") return "Copilot Business";
  if (sku === "copilot_enterprise") return "Copilot Enterprise";
  const parts = sku.split("_");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (/^\d+$/.test(p) && parts[i + 1] === "core") {
      out.push(`${p}-core`);
      i++;
      continue;
    }
    if (/^d\d+$/.test(p)) {
      out.push(`${p.slice(1)}-core`);
      continue;
    }
    out.push(WORDS[p] ?? p.charAt(0).toUpperCase() + p.slice(1));
  }
  return out.join(" ");
}

/** Which runner OS an Actions minute SKU ran on, or undefined for non-minute SKUs. */
export function runnerOs(rawSku: string | undefined): "Linux" | "Windows" | "macOS" | undefined {
  const sku = normalizeId(rawSku);
  if (!sku.startsWith("actions_") || sku.includes("storage")) return undefined;
  if (sku.includes("linux")) return "Linux";
  if (sku.includes("windows")) return "Windows";
  if (sku.includes("macos")) return "macOS";
  return undefined;
}

/**
 * The SKU a GitHub-hosted larger runner bills under, from its platform
 * (`linux-x64`, `linux-arm64`, `win-x64`, `win-arm64`) and core count. The
 * standard 2-core Linux and Windows machines bill as plain `actions_linux` /
 * `actions_windows`. Returns undefined for anything that does not fit the
 * documented naming, rather than guessing.
 */
export function hostedRunnerSku(
  platform: string | undefined,
  cores: number | undefined,
): string | undefined {
  const p = (platform ?? "").toLowerCase();
  const os = p.startsWith("linux") ? "linux" : p.startsWith("win") ? "windows" : undefined;
  if (!os || !cores) return undefined;
  const arm = p.includes("arm");
  if (cores === 2)
    return arm
      ? `actions_${os}_2_core_arm`
      : os === "linux"
        ? "actions_linux"
        : "actions_windows_2_core";
  const sku = `actions_${os}_${cores}_core${arm ? "_arm" : ""}`;
  return SKUS.includes(sku) ? sku : undefined;
}

/** Budget product choices: `product:<id>`, `sku:<id>`, or the AI-credit bundle. */
export function budgetProductOptions(): Array<{ id: string; label: string; description?: string }> {
  return [
    { id: "bundle:ai_credits", label: "All AI credits", description: "Every AI-credit SKU" },
    ...PRODUCTS.map((p) => ({
      id: `product:${p.id}`,
      label: `${p.label} (all SKUs)`,
      description: "Product",
    })),
    ...SKUS.map((s) => ({ id: `sku:${s}`, label: skuLabel(s), description: s })),
  ];
}

export type BudgetType = "ProductPricing" | "SkuPricing" | "BundlePricing";

export function parseBudgetProduct(value: string): { type: BudgetType; sku: string } {
  const [kind, ...rest] = value.split(":");
  const sku = rest.join(":");
  if (kind === "bundle") return { type: "BundlePricing", sku: sku || "ai_credits" };
  if (kind === "product") return { type: "ProductPricing", sku };
  if (kind === "sku") return { type: "SkuPricing", sku };
  // A bare identifier: a product if GitHub lists it as one, otherwise a SKU.
  return PRODUCTS.some((p) => p.id === value)
    ? { type: "ProductPricing", sku: value }
    : { type: "SkuPricing", sku: value };
}

/** Human label for a budget's product or SKU. */
export function budgetProductLabel(type: string | undefined, sku: string | undefined): string {
  if (type === "BundlePricing") return "AI credits";
  if (type === "ProductPricing") return productLabel(sku);
  return skuLabel(sku) || sku || "";
}
