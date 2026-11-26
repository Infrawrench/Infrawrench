/**
 * The MCP server: `tools.ts`'s definitions registered with the SDK, for one
 * request and one caller. Stateless, like the protocol: a fresh instance per
 * request closes over that request's credential, so one connection can never
 * be handed another's.
 */
import { type JsonSchemaType, McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { describeError } from "../http/log";
import { ToolFailure } from "./api";
import { TOOLS, type ToolContext } from "./tools";

export const MCP_SERVER_NAME = "infrawrench-git";
export const MCP_SERVER_TITLE = "git.infrawrench.com";
/** Bumped when a tool is added, removed or changes what it takes. */
export const MCP_SERVER_VERSION = "1.0.0";

/** What a client shows the model about the server as a whole. */
export const MCP_INSTRUCTIONS = [
  "This is git.infrawrench.com, a Git forge where a branch is reviewed as a record of versions: every push to a branch makes a version, and what you record about your work is attached to it.",
  "",
  "If you write code on a branch here:",
  "1. Call record_trace as you work: the ask, each step, each decision, evidence for what you ran (command, exit code, the output that shows the result), and any doubt. Record before you push; entries are attached to the version the next push makes.",
  "2. After a push, call get_branch to see the branch's state, list_instructions for what reviewers sent back, and list_findings for what review agents found.",
  "3. For each instruction you take on: mark_instruction_delivered, do the work, record it, mark_instruction_answered, then push.",
  "",
  "If you review code here: read the change with get_branch and get_version_diff, then report_finding.",
  "",
  "If you are given a task and no branch exists yet: start_work makes the branch and its page from the ask.",
].join("\n");

export type ServerContext = Omit<ToolContext, "clientName"> & {
  /** What to call the client when it did not say (from its `User-Agent`). */
  readonly fallbackClientName: string | null;
};

export const buildMcpServer = (cx: ServerContext): McpServer => {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, title: MCP_SERVER_TITLE, version: MCP_SERVER_VERSION },
    { instructions: MCP_INSTRUCTIONS },
  );
  const clientName = (): string | null => {
    try {
      return server.server.getClientVersion()?.name ?? cx.fallbackClientName;
    } catch {
      return cx.fallbackClientName;
    }
  };
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema as JsonSchemaType),
        outputSchema: fromJsonSchema<Record<string, unknown>>(tool.outputSchema as JsonSchemaType),
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly,
          // Nothing here deletes or overwrites: the writes add to a record.
          destructiveHint: false,
          idempotentHint: tool.idempotent,
          // Every tool reads and writes this forge and nothing beyond it.
          openWorldHint: false,
        },
      },
      async (input) => {
        try {
          const result = await tool.run(input, {
            api: cx.api,
            principal: cx.principal,
            origin: cx.origin,
            clientName: clientName(),
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          };
        } catch (error) {
          if (error instanceof ToolFailure) {
            return { content: [{ type: "text" as const, text: error.message }], isError: true };
          }
          console.error(`[git] mcp tool ${tool.name} failed: ${describeError(error)}`);
          return {
            content: [
              {
                type: "text" as const,
                text: `${tool.title}: the forge failed to answer. Nothing is known to have changed; try again.`,
              },
            ],
            isError: true,
          };
        }
      },
    );
  }
  return server;
};
