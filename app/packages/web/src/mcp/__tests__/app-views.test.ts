// The registry import reaches db/client and the WorkOS client, both of which
// throw at import time without these. No connection is opened.
process.env["DATABASE_URL"] ??= "postgres://test:test@localhost:5432/test";
process.env["ENCRYPTION_MASTER_KEY"] ??= Buffer.alloc(32, 1).toString("base64");
process.env["WORKOS_API_KEY"] ??= "test_workos_api_key";
process.env["WORKOS_CLIENT_ID"] ??= "test_workos_client_id";

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MCP_VIEWS, TOOL_VIEWS, mcpViewUri, toolViewMeta } from "@/mcp/app-views";
import { renderMcpViewsModule } from "@/mcp/app-views-build";

const GEN = new URL("../app-views.gen.ts", import.meta.url);

describe("MCP Apps views", () => {
  it("are generated from src/mcp/views", async () => {
    // Stale? Run: pnpm --filter @infrawrench/web generate:mcp-views
    expect(readFileSync(GEN, "utf8")).toBe(await renderMcpViewsModule());
  }, 30_000);

  it("are each one self-contained page, small enough to send whole", async () => {
    const { MCP_VIEW_HTML } = await import("@/mcp/app-views.gen");
    for (const id of Object.keys(MCP_VIEWS) as Array<keyof typeof MCP_VIEWS>) {
      const html = MCP_VIEW_HTML[id];
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain("ui/initialize");
      // Nothing loaded from elsewhere: the views ask for no CSP domains.
      expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
      expect(html.length).toBeLessThan(40_000);
    }
  });

  it("are named only by tools the registry has", { timeout: 30_000 }, async () => {
    const { getToolRegistry } = await import("@/tools/registry");
    const names = new Set((await getToolRegistry()).map((t) => t.name));
    for (const tool of Object.keys(TOOL_VIEWS)) expect(names).toContain(tool);
  });

  it("are named in a tool's _meta by ui:// address", () => {
    expect(toolViewMeta("query_costs")).toEqual({
      ui: { resourceUri: "ui://infrawrench/costs.html" },
    });
    expect(toolViewMeta("delete_resource")).toBeUndefined();
    expect(mcpViewUri("resources")).toBe("ui://infrawrench/resources.html");
  });
});
