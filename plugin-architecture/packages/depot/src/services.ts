/** The `service` names cost rows carry, shared by the estimate and the invoice rows. */
export const SERVICE = {
  builds: "Container builds",
  actions: "GitHub Actions runners",
  macos: "GitHub Actions runners (macOS)",
  cache: "Cache storage",
  registry: "Registry storage",
  sandboxes: "Agent sandboxes",
  ci: "Depot CI",
  plan: "Depot plan",
  /** What an invoice's total holds beyond the sum of its lines. */
  invoiceAdjustment: "Invoice adjustments",
  /** A line with no description to name it by. */
  other: "Other charges",
} as const;
