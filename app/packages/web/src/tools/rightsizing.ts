/**
 * Right-sizing tool — the MCP/chat view of the savings finder's "Oversized"
 * section. Read-only: applying a recommendation goes through the ordinary
 * resource-update path (the web/desktop Apply button), which is what carries
 * change-freeze enforcement and audit logging.
 */
import { z } from "zod";
import { listRightsizing } from "../services/rightsizing";
import { ok, type ToolDefinition } from "./types";

export function rightsizingTools(): ToolDefinition[] {
  return [
    {
      name: "list_oversized_resources",
      title: "List oversized resources",
      description:
        "Resources whose p95 CPU/memory utilisation over the last 14 days of stored metrics " +
        "sits well under their current size, each with the cheapest smaller size from the " +
        "provider's own catalog that still clears a headroom margin, and the live-priced " +
        "monthly saving. Covers plugins that declare right-sizing support (Hetzner servers, " +
        "DigitalOcean Droplets, EC2 instances, Azure VMs, GCE instances). Purely a read; " +
        "results are cached for a few minutes — pass refresh to recompute.",
      inputSchema: {
        refresh: z
          .boolean()
          .optional()
          .describe("Bypass the short server-side cache and recompute now."),
      },
      risk: "read",
      permission: "resources:read",
      handler: async (input, auth) => {
        const refresh = Boolean((input as { refresh?: boolean }).refresh);
        return ok(await listRightsizing(auth.organizationId, { refresh }));
      },
    },
  ];
}
