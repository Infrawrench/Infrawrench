import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGenericTools } from "./tools/generic";
import { registerPerPluginCreateTools } from "./tools/per-plugin-create";
import type { McpAuthContext } from "./auth";

export const SERVER_NAME = "infrawrench";
export const SERVER_VERSION = "0.1.0";

/**
 * Builds a fresh McpServer instance scoped to a single authenticated caller.
 * Tool handlers close over the auth context, so each connection sees only the
 * caller's organization. Stateless — one server per HTTP request.
 */
export async function buildMcpServer(auth: McpAuthContext): Promise<McpServer> {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  registerGenericTools(server, auth);
  await registerPerPluginCreateTools(server, auth);
  return server;
}
