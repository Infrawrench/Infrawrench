import type { ZodTypeAny } from "zod";
import type { Permission } from "@infrawrench/server-core/permissions/catalog";

/**
 * Tool risk tiers: used to gate destructive actions behind UI approval in the
 * chat agent. MCP exposes every tool regardless of risk; risk only affects the
 * chat surface where the human is in the loop.
 *
 * - `read`     non-mutating queries (listResources, getResource, listAccounts…)
 * - `write`    creates / non-destructive mutations (createResource…)
 * - `destructive`  deletions, manifest applies, exec, write SQL, add/destroy
 *                  secret versions, credential exports, anything that runs
 *                  code or input on a host, schedules state changes, or saves
 *                  code that later runs unattended: always confirm in UI.
 *
 * A tool whose danger depends on its input (a launcher that also takes a raw
 * command, an editor whose save can arm a cron) keeps its tier and adds
 * {@link ToolDefinition.requiresApproval}; chat gates through `needsApproval`
 * in `./approval`, the single check every human-in-the-loop surface keys off.
 */
type ToolRisk = "read" | "write" | "destructive";

export interface ToolAuthContext {
  userId: string;
  organizationId: string;
  email?: string;
  /** Set when the caller authed via API key: used for audit metadata. */
  apiKeyId?: string;
  /**
   * The API key's scopes, when the caller authed via API key. Effective
   * permissions are the INTERSECTION of these and the user's role permissions,
   * so a narrowly-scoped key can never act with its owner's full authority.
   * Absent for session/OAuth principals, who act with their role's permissions.
   *
   * For an **agent** they are the final answer rather than a ceiling: see
   * `auth/effective-permissions.ts`.
   */
  scopes?: readonly string[];
  /**
   * Set when the caller is an agent-auth registration. `userId` beside it is
   * the agent's own user row, never a person's: a handler that means "the
   * human who did this" must check here before attributing anything, and
   * nothing may derive authority from that row's membership role.
   */
  agentRegistrationId?: string;
  /** "mcp" | "chat" | "api": written into audit metadata. */
  source: "mcp" | "chat" | "api";
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  /**
   * Optional base64 image blocks. The MCP server forwards these to the client
   * so a model can see a screenshot; the chat surface ignores them, because its
   * persisted content contract is text-only and shared with mobile: the text
   * `content` (a caption) is what it shows there.
   */
  images?: Array<{ data: string; mimeType: string }>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /**
   * Zod-shaped input schema: keys are field names, values are Zod types. This
   * is the format the MCP SDK accepts. The chat agent converts it to JSON
   * Schema via zod-to-json-schema for the Anthropic tool_use API.
   */
  inputSchema: Record<string, ZodTypeAny>;
  risk: ToolRisk;
  /**
   * Per-call escalation for a tool whose risk depends on its input or its
   * target. When it resolves true the chat surface queues the call for
   * approval exactly as it would a `destructive` tool; a throw is treated as
   * true (see `needsApproval` in `./approval`). Only ever widens the gate: a
   * `destructive` tool always needs approval. Chat-only, like `risk`; MCP
   * ignores it. Used by `sql_query`, which is only a guaranteed read on
   * engines that can run it in a read-only transaction; by `write` tools
   * where one argument turns the call into running code (`launch_app` with
   * `exec`, `write_workflow` saving source or arming a trigger,
   * `write_custom_graph` saving source); by `get_resource_outputs` when it
   * would return a sensitive, hidden or undeclared output; and by
   * `web_fetch` of a URL the user never supplied.
   */
  requiresApproval?(input: Record<string, unknown>, auth: ToolAuthContext): Promise<boolean>;
  /**
   * Permission the caller must hold, enforced centrally by
   * {@link authorizeToolCall} at every dispatch site (MCP + chat): NOT by the
   * handler. Must mirror the `requirePermission` on the equivalent HTTP route
   * so the two surfaces can't drift apart.
   *
   * `null` means the tool exposes no organization data at all (static plugin
   * catalogs) and is safe for any authenticated member. It is deliberately
   * required rather than optional so a new tool cannot silently default to
   * ungated.
   */
  permission: Permission | null;
  handler(input: Record<string, unknown>, auth: ToolAuthContext): Promise<ToolResult>;
}

/** True when `value` is a string with something other than whitespace in it. */
export function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function ok(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

export function okText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * A base64 image plus a text caption. The caption is what the chat surface
 * shows (it cannot carry the image); an MCP client gets the image too.
 */
export function okImage(base64: string, mimeType: string, caption: string): ToolResult {
  return {
    content: [{ type: "text", text: caption }],
    images: [{ data: base64, mimeType }],
  };
}

export function err(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
