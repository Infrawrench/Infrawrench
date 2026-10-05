/**
 * Shared tool registry: consumed by both the MCP server (mcp/server.ts) and
 * the chat agent loop (chat/agent.ts). Returns plain {@link ToolDefinition}
 * objects rather than calling server.registerTool directly so the chat agent
 * can drive the same handlers without going through MCP framing.
 *
 * Per-plugin tools are dynamic (depend on installed plugins) so this is async.
 */
import { genericTools } from "./generic";
import { perPluginCreateTools } from "./per-plugin-create";
import { connectionTools } from "./connections";
import { costTools } from "./costs";
import { costAnomalyFeedbackTools } from "./cost-anomaly-feedback";
import { unitCostTools } from "./unit-costs";
import { virtualTagTools } from "./virtual-tags";
import { costReportTools } from "./cost-reports";
import { costCanvasTools } from "./cost-canvases";
import { costAlertTools } from "./cost-alerts";
import { invoiceTools } from "./invoices";
import { scheduleTools } from "./schedules";
import { rightsizingTools } from "./rightsizing";
import { githubIssueTools } from "./github-issues";
import { carbonTools } from "./carbon";
import { priceCatalogTools } from "./price-catalog";
import { aiAttributionTools } from "./ai-attribution";
import { momentTools } from "./moment";
import { customGraphTools } from "./custom-graphs";
import { workflowTools } from "./workflows";
import { deploymentTools } from "./deployments";
import { sshKeyTools } from "./ssh-keys";
import { sshHostKeyTools } from "./ssh-host-keys";
import { linuxAppTools } from "./linux-apps";
import type { ToolDefinition } from "./types";

let cached: ToolDefinition[] | null = null;

export async function getToolRegistry(): Promise<ToolDefinition[]> {
  if (cached) return cached;
  const tools: ToolDefinition[] = [
    ...genericTools(),
    ...connectionTools(),
    ...costTools(),
    ...costAnomalyFeedbackTools(),
    ...unitCostTools(),
    ...virtualTagTools(),
    ...costReportTools(),
    ...costCanvasTools(),
    ...costAlertTools(),
    ...invoiceTools(),
    ...scheduleTools(),
    ...rightsizingTools(),
    ...githubIssueTools(),
    ...carbonTools(),
    ...priceCatalogTools(),
    ...aiAttributionTools(),
    ...momentTools(),
    ...workflowTools(),
    ...customGraphTools(),
    ...deploymentTools(),
    ...sshKeyTools(),
    ...sshHostKeyTools(),
    ...linuxAppTools(),
    ...(await perPluginCreateTools()),
  ];
  cached = tools;
  return tools;
}
