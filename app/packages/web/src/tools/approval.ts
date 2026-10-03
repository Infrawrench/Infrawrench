import type { ToolAuthContext, ToolDefinition } from "./types";

/**
 * Whether a chat tool call waits for the user: every `destructive` tool, plus
 * any call a tool's own `requiresApproval` escalates. That check fails closed,
 * so a lookup error parks the call for approval rather than running it.
 */
export async function needsApproval(
  tool: Pick<ToolDefinition, "risk" | "requiresApproval">,
  input: Record<string, unknown>,
  auth: ToolAuthContext,
): Promise<boolean> {
  if (tool.risk === "destructive") return true;
  if (!tool.requiresApproval) return false;
  try {
    return await tool.requiresApproval(input, auth);
  } catch {
    return true;
  }
}
