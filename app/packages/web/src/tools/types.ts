import type { ZodTypeAny } from "zod";

/**
 * Tool risk tiers — used to gate destructive actions behind UI approval in the
 * chat agent. MCP exposes every tool regardless of risk; risk only affects the
 * chat surface where the human is in the loop.
 *
 * - `read`     non-mutating queries (listResources, getResource, listAccounts…)
 * - `write`    creates / non-destructive mutations (createResource…)
 * - `destructive`  deletions, manifest applies, exec, write SQL, add/destroy
 *                  secret versions, credential exports — always confirm in UI.
 */
export type ToolRisk = "read" | "write" | "destructive";

export interface ToolAuthContext {
  userId: string;
  organizationId: string;
  email?: string;
  /** Set when the caller authed via API key — used for audit metadata. */
  apiKeyId?: string;
  /** "mcp" | "chat" | "api" — written into audit metadata. */
  source: "mcp" | "chat" | "api";
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /**
   * Zod-shaped input schema — keys are field names, values are Zod types. This
   * is the format the MCP SDK accepts. The chat agent converts it to JSON
   * Schema via zod-to-json-schema for the Anthropic tool_use API.
   */
  inputSchema: Record<string, ZodTypeAny>;
  risk: ToolRisk;
  handler(input: Record<string, unknown>, auth: ToolAuthContext): Promise<ToolResult>;
}

export function ok(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

export function okText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function err(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
