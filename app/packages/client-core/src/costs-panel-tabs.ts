/**
 * The Costs page is split into tabs on every surface. The ids live here so
 * web, desktop and mobile agree, and so a mobile push can open the tab that
 * holds the section it is about.
 */
export const COSTS_PANEL_TABS = [
  "overview",
  "alerts",
  "savings",
  "commitments",
  "network",
  "carbon",
  "allocation",
] as const;

export type CostsPanelTab = (typeof COSTS_PANEL_TABS)[number];

export function isCostsPanelTab(value: unknown): value is CostsPanelTab {
  return typeof value === "string" && (COSTS_PANEL_TABS as readonly string[]).includes(value);
}
