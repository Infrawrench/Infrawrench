import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getToolRegistry } from "../tools/registry";
import { hasMembership, listUserOrganizations } from "../api/auth-middleware";
import type { ToolAuthContext } from "../tools/types";
import type { McpAuthContext } from "./auth";

const SERVER_NAME = "infrawrench";
const SERVER_VERSION = "0.1.0";

/**
 * Every MCP tool takes an optional `org_id`. This is MCP-only: it is injected
 * here rather than in the shared registry (src/tools/registry.ts) because the
 * chat agent already knows its organization from the session and must not be
 * able to reach across orgs. An MCP client has no org picker and its OAuth
 * token is not guaranteed to carry an `org_id` claim, so the parameter is the
 * only way for a caller with several orgs to address a non-default one.
 */
const ORG_ID_PARAM = z
  .string()
  .optional()
  .describe(
    "Organization to run this call against. Defaults to your oldest membership. " +
      "Call list_organizations to see the options and which one is the default.",
  );

/**
 * Resolves the org for a single tool call. An explicit `org_id` is always
 * membership-checked, so this can never widen access beyond the orgs the
 * authenticated user already belongs to.
 */
async function resolveCallAuth(
  base: ToolAuthContext,
  orgId: string | undefined,
): Promise<ToolAuthContext | { error: string }> {
  if (!orgId || orgId === base.organizationId) return base;
  if (!(await hasMembership(base.userId, orgId))) {
    return { error: `You are not a member of organization ${orgId}.` };
  }
  return { ...base, organizationId: orgId };
}

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

  // MCP-only. The chat agent has no org switcher, so this would be dead weight
  // (and misleading) in the shared registry.
  server.registerTool(
    "list_organizations",
    {
      title: "List organizations",
      description:
        "Lists the organizations you belong to, with the id to pass as `org_id` on any " +
        "other tool. The entry marked `default: true` is used when `org_id` is omitted.",
      inputSchema: {},
    },
    async () => {
      const orgs = await listUserOrganizations(toolAuth.userId);
      const payload = orgs.map((o) => ({
        org_id: o.id,
        name: o.displayName,
        role: o.role,
        default: o.id === toolAuth.organizationId,
      }));
      // Returned as a fresh object literal, not a ToolResult: the SDK's result
      // type needs an index signature, which only literals get implicitly.
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        isError: false,
      };
    },
  );

  const tools = await getToolRegistry();
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: { ...tool.inputSchema, org_id: ORG_ID_PARAM },
      },
      async (input) => {
        const { org_id: orgId, ...rest } = input as Record<string, unknown>;
        const callAuth = await resolveCallAuth(
          toolAuth,
          typeof orgId === "string" ? orgId : undefined,
        );
        if ("error" in callAuth) {
          return {
            content: [{ type: "text" as const, text: callAuth.error }],
            isError: true,
          };
        }

        const result = await tool.handler(rest, callAuth);
        return { content: result.content, isError: result.isError ?? false };
      },
    );
  }

  return server;
}
