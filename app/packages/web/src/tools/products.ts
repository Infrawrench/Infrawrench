/**
 * Which app ("product") a tool belongs to, for the organization's app policy
 * (`@infrawrench/server-core/products/settings`): a tool whose app is turned
 * off is not offered to, and is refused for, the chat agent and MCP clients.
 *
 * Most tool modules belong to one app whole and are tagged in `./registry`
 * with {@link forProduct}. `./generic` is mixed, so its tools that belong to
 * an app are named in {@link GENERIC_TOOL_PRODUCTS}; the rest of it
 * (resources, accounts, DNS, manifests) is Infrastructure, which cannot be
 * turned off, and stays untagged.
 */
import type { ProductId } from "@infrawrench/client-core";
import type { ToolDefinition } from "./types";

/**
 * Tools of `./generic` that belong to an app, by name. A registry test fails
 * when a name here is no longer a registered tool.
 */
export const GENERIC_TOOL_PRODUCTS: Readonly<Record<string, ProductId>> = {
  list_expiring: "security",
  list_posture_findings: "security",
  dismiss_posture_finding: "security",
  restore_posture_finding: "security",
  diff_environments: "delivery",
  list_status_pages: "incidents",
};

/** Tags every tool of one module with its app; a tool already tagged keeps its own. */
export function forProduct(product: ProductId, tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => ({ ...tool, product: tool.product ?? product }));
}

/** Tags the tools a by-name map claims and leaves the rest as they are. */
export function withProductOverrides(
  tools: ToolDefinition[],
  overrides: Readonly<Record<string, ProductId>>,
): ToolDefinition[] {
  return tools.map((tool) => {
    const product = Object.hasOwn(overrides, tool.name) ? overrides[tool.name] : undefined;
    return product ? { ...tool, product } : tool;
  });
}
