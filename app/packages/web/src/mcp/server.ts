import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getToolRegistry } from "../tools/registry";
import type { ToolAuthContext } from "../tools/types";
import type { McpAuthContext } from "./auth";

const SERVER_NAME = "infrawrench";
const SERVER_VERSION = "0.1.0";

/**
 * Builds a fresh McpServer instance scoped to a single authenticated caller.
 * Tool handlers close over the auth context, so each connection sees only the
 * caller's organization. Stateless — one server per HTTP request.
 *
 * Tools are sourced from the shared registry (src/tools/registry.ts), which is
 * also consumed by the chat agent loop.
 */
export async function buildMcpServer(auth: McpAuthContext): Promise<McpServer> {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const toolAuth: ToolAuthContext = {
    userId: auth.userId,
    organizationId: auth.organizationId,
    source: "mcp",
    ...(auth.email !== undefined ? { email: auth.email } : {}),
  };

  const tools = await getToolRegistry();
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (input) => {
        const result = await tool.handler(input as Record<string, unknown>, toolAuth);
        return { content: result.content, isError: result.isError ?? false };
      },
    );
  }

  return server;
}
