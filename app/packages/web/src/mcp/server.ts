import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import type { JsonSchemaType } from "@modelcontextprotocol/server";
import { z, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getToolRegistry } from "../tools/registry";
import { authorizeToolCall } from "../tools/permissions";
import { getClaimStatus } from "@infrawrench/server-core/trials/ceremony";
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
 * Converts a registry tool's Zod shape (Zod 3, shared with the chat agent) to
 * the Standard Schema the v2 SDK's `registerTool` takes. The SDK is pinned to
 * Zod 4, so the shape cannot be handed over directly; instead it goes through
 * JSON Schema — the same conversion, with the same trimming, that
 * `toolToProvider` in src/chat/agent.ts does for the Anthropic API. The SDK's
 * built-in validator then enforces it on 2026-era and legacy calls alike.
 */
function toInputSchema(shape: Record<string, ZodTypeAny>) {
  const schema = zodToJsonSchema(z.object(shape), { $refStrategy: "none" }) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  return fromJsonSchema<Record<string, unknown>>({
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  } as JsonSchemaType);
}

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
  // An agent credential is bound to the one org its registration opened. The
  // membership check below would not catch this on its own — the agent *is* a
  // member of its own org and of nothing else — but the error it produced would
  // read as "ask someone to add you", which is the wrong instruction for a
  // principal that can never belong anywhere else.
  if (base.agentRegistrationId) {
    return { error: "An agent credential can only act in the organization it was issued for." };
  }
  if (!(await hasMembership(base.userId, orgId))) {
    return { error: `You are not a member of organization ${orgId}.` };
  }
  return { ...base, organizationId: orgId };
}

/**
 * Builds a fresh McpServer instance scoped to a single authenticated caller.
 * Tool handlers close over the auth context, so each connection sees only the
 * caller's organization. Stateless — one server per HTTP request, which is
 * also the 2026-07-28 protocol's model: the http-handler serves each request
 * with a fresh instance whichever protocol era the client speaks.
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
    // An agent's permissions arrive already intersected with its claimer's role
    // and the agent ceiling, so they ride the same `scopes` channel API keys
    // use. `agentRegistrationId` beside them is load-bearing, not just audit
    // metadata: it tells `effectivePermissions` these are the final answer
    // rather than a ceiling to re-intersect with the role of the `users` row
    // the agent acts as — that row is a plain `member` on purpose, and
    // intersecting with it would deny over MCP what the same credential is
    // granted over HTTP.
    ...(auth.agent
      ? {
          agentRegistrationId: auth.agent.registrationId,
          scopes: auth.agent.permissions,
        }
      : {}),
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
      inputSchema: toInputSchema({}),
    },
    async () => {
      const orgs = await listUserOrganizations(toolAuth.userId);
      const payload = orgs.map((o) => ({
        org_id: o.id,
        name: o.displayName,
        role: o.role,
        default: o.id === toolAuth.organizationId,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        isError: false,
      };
    },
  );

  // Agent-only, and registered only for agents: a human's MCP client has no
  // trial and no ceremony to run, so offering the tool would be noise on every
  // ordinary connection.
  if (auth.agent) {
    const agent = auth.agent;
    server.registerTool(
      "trial_workspace_status",
      {
        title: "Trial workspace status",
        description:
          "How long this trial workspace has left before it is deleted, and whether a person " +
          "has claimed it yet. Check this before doing substantial work, and tell the user " +
          "what you find — an unclaimed workspace is deleted along with everything in it.",
        inputSchema: toInputSchema({}),
      },
      async () => {
        // Re-read rather than closing over the connection-time value: an MCP
        // connection can outlive the claim, and a cached "unclaimed" would have
        // the agent nagging someone who already dealt with it.
        const status = await getClaimStatus(agent.registrationId);
        const remainingMs = status?.trialExpiresInMs ?? null;
        const payload = {
          claimed: status?.claimed ?? agent.claimed,
          claim_pending: status?.claimPending ?? false,
          expires_in_ms: remainingMs,
          expires_in_hours: remainingMs === null ? null : Math.floor(remainingMs / 3_600_000),
          claim_instructions: status?.claimed
            ? null
            : "Call POST /api/agent/identity/claim to get a code, then give the user the code " +
              "and the verification URL together in one message.",
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          isError: false,
        };
      },
    );
  }

  const tools = await getToolRegistry();
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: toInputSchema({ ...tool.inputSchema, org_id: ORG_ID_PARAM }),
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

        // Central permission gate — MCP clients reach these handlers without
        // passing through the HTTP `requirePermission` middleware, so the
        // tool's declared permission is enforced here instead.
        const denied = await authorizeToolCall(tool, callAuth);
        if (denied) return { content: denied.content, isError: true };

        const result = await tool.handler(rest, callAuth);
        // Images ride a side channel on the chat surface (its content contract
        // is text-only); an MCP client can render them, so a screenshot the
        // model can actually see is appended in the SDK's image shape.
        const content = [
          ...result.content.map((block) => ({ type: "text" as const, text: block.text })),
          ...(result.images ?? []).map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ];
        return { content, isError: result.isError ?? false };
      },
    );
  }

  return server;
}
