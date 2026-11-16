/**
 * Which app ("product") a tool belongs to, for the organization's app policy
 * (`@infrawrench/server-core/products/settings`): a tool whose app is turned
 * off is not offered to, and is refused for, the chat agent and MCP clients.
 *
 * Most tool modules belong to one app whole and are tagged in `./registry`
 * with {@link forProduct}. A module of mixed tools (`./generic`) names the app
 * on each definition that belongs to one; the rest of it is Infrastructure,
 * which cannot be turned off, and stays untagged.
 */
import type { ProductId } from "@infrawrench/client-core";
import type { ToolDefinition } from "./types";

/** Tags every tool of one module with its app; a tool already tagged keeps its own. */
export function forProduct(product: ProductId, tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => ({ ...tool, product: tool.product ?? product }));
}
