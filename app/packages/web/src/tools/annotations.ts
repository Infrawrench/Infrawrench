/**
 * MCP tool annotations (`ToolAnnotations` in the MCP schema), derived from
 * what a {@link ToolDefinition} already declares so they cannot drift from the
 * risk tier the chat approval gate uses.
 *
 * The spec's defaults are the pessimistic ones (a tool with no annotations is
 * assumed destructive and open-world), so every hint is stated explicitly.
 * `destructiveHint` and `idempotentHint` only mean something when
 * `readOnlyHint` is false, so a read tool carries neither.
 */
import type { ToolDefinition } from "./types";

export interface McpToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  openWorldHint: boolean;
}

type AnnotatedTool = Pick<
  ToolDefinition,
  "title" | "risk" | "openWorld" | "overwrites" | "pluginId"
>;

export function toolAnnotations(tool: AnnotatedTool): McpToolAnnotations {
  const openWorldHint = tool.openWorld === true || tool.pluginId !== undefined;
  if (tool.risk === "read") {
    return { title: tool.title, readOnlyHint: true, openWorldHint };
  }
  return {
    title: tool.title,
    readOnlyHint: false,
    destructiveHint: tool.risk === "destructive" || tool.overwrites === true,
    openWorldHint,
  };
}
