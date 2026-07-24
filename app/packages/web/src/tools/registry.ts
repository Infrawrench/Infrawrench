/**
 * Shared tool registry — consumed by both the MCP server (mcp/server.ts) and
 * the chat agent loop (chat/agent.ts). Returns plain {@link ToolDefinition}
 * objects rather than calling server.registerTool directly so the chat agent
 * can drive the same handlers without going through MCP framing.
 *
 * Per-plugin tools are dynamic (depend on installed plugins) so this is async.
 */
import { genericTools } from "./generic";
import { perPluginCreateTools } from "./per-plugin-create";
import { connectionTools } from "./connections";
import { costTools } from "./costs";
import { sshKeyTools } from "./ssh-keys";
import { sshHostKeyTools } from "./ssh-host-keys";
import type { ToolDefinition } from "./types";

let cached: ToolDefinition[] | null = null;

export async function getToolRegistry(): Promise<ToolDefinition[]> {
  if (cached) return cached;
  const tools: ToolDefinition[] = [
    ...genericTools(),
    ...connectionTools(),
    ...costTools(),
    ...sshKeyTools(),
    ...sshHostKeyTools(),
    ...(await perPluginCreateTools()),
  ];
  cached = tools;
  return tools;
}
