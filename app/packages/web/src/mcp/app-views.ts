/**
 * MCP Apps views (https://modelcontextprotocol.io/extensions/apps): HTML an
 * MCP client that supports them (Claude, ChatGPT, Nibblets, VS Code) shows
 * in its chat when one of these tools is called, given the call's input and
 * result. A tool names its view's `ui://` resource in `_meta.ui`; clients
 * that don't support views ignore it and read the text as before.
 *
 * MCP-only, like `org_id`: the in-app chat draws its own results, so the
 * shared registry knows nothing of views. The views' source is in `./views/`,
 * bundled into `./app-views.gen.ts` by `generate:mcp-views`.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { MCP_VIEW_HTML } from "./app-views.gen";

/** What an MCP App's HTML is served as. */
const MCP_APP_MIME = "text/html;profile=mcp-app";

export const MCP_VIEWS = {
  costs: { title: "Costs", entry: "costs.ts" },
  metrics: { title: "Metrics", entry: "metrics.ts" },
  resources: { title: "Resources", entry: "resources.ts" },
} as const;

export type McpViewId = keyof typeof MCP_VIEWS;

/** The registry tools with a view, and which. */
export const TOOL_VIEWS: Readonly<Record<string, McpViewId>> = {
  query_costs: "costs",
  get_resource_metrics: "metrics",
  list_resources: "resources",
  search_resources: "resources",
};

export function mcpViewUri(id: McpViewId): string {
  return `ui://infrawrench/${id}.html`;
}

/** A tool's `_meta`, naming its view, or nothing for a tool without one. */
export function toolViewMeta(toolName: string): { ui: { resourceUri: string } } | undefined {
  const id = TOOL_VIEWS[toolName];
  return id ? { ui: { resourceUri: mcpViewUri(id) } } : undefined;
}

/**
 * Serves every view as a resource. A view loads nothing from elsewhere and
 * calls back only through its host, so it asks for no CSP domains.
 */
export function registerMcpViews(server: McpServer): void {
  for (const id of Object.keys(MCP_VIEWS) as McpViewId[]) {
    const uri = mcpViewUri(id);
    server.registerResource(
      `view-${id}`,
      uri,
      {
        title: `${MCP_VIEWS[id].title} view`,
        description: `The MCP Apps view for ${MCP_VIEWS[id].title.toLowerCase()}.`,
        mimeType: MCP_APP_MIME,
      },
      async () => ({
        contents: [
          {
            uri,
            mimeType: MCP_APP_MIME,
            text: MCP_VIEW_HTML[id],
            _meta: { ui: { prefersBorder: true } },
          },
        ],
      }),
    );
  }
}
