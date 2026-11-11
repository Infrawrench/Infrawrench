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
import { kubernetesEfficiencyTools } from "./k8s-efficiency";
import { costAlertTools } from "./cost-alerts";
import { invoiceTools } from "./invoices";
import { scheduleTools } from "./schedules";
import { rightsizingTools } from "./rightsizing";
import { githubIssueTools } from "./github-issues";
import { savingsTools } from "./savings";
import { extendedSupportTools } from "./extended-support";
import { seatTools } from "./seats";
import { carbonTools } from "./carbon";
import { priceCatalogTools } from "./price-catalog";
import { instancePricingTools } from "./instance-pricing";
import { aiAttributionTools } from "./ai-attribution";
import { networkCostTools } from "./network-costs";
import { momentTools } from "./moment";
import { customGraphTools } from "./custom-graphs";
import { workflowTools } from "./workflows";
import { deploymentTools } from "./deployments";
import { sshKeyTools } from "./ssh-keys";
import { sshHostKeyTools } from "./ssh-host-keys";
import { linuxAppTools } from "./linux-apps";
import { vulnerabilityTools } from "./vulnerabilities";
import { forProduct, GENERIC_TOOL_PRODUCTS, withProductOverrides } from "./products";
import type { ToolDefinition } from "./types";

let cached: ToolDefinition[] | null = null;

export async function getToolRegistry(): Promise<ToolDefinition[]> {
  if (cached) return cached;
  const tools: ToolDefinition[] = [
    // Tagged with the app each belongs to, for the organization's app policy
    // (`./products`). Untagged modules are always available: connections,
    // SSH keys and host keys, Linux apps and the per-plugin create tools are
    // Infrastructure; sleep/wake schedules act on resources; GitHub issues and
    // IaC pull requests, the moment view and custom graphs cut across apps.
    ...withProductOverrides(genericTools(), GENERIC_TOOL_PRODUCTS),
    ...connectionTools(),
    ...forProduct("costs", costTools()),
    ...forProduct("costs", costAnomalyFeedbackTools()),
    ...forProduct("costs", unitCostTools()),
    ...forProduct("costs", virtualTagTools()),
    ...forProduct("costs", costReportTools()),
    ...forProduct("costs", costCanvasTools()),
    ...forProduct("costs", kubernetesEfficiencyTools()),
    ...forProduct("costs", costAlertTools()),
    ...forProduct("costs", invoiceTools()),
    ...scheduleTools(),
    ...forProduct("costs", rightsizingTools()),
    ...githubIssueTools(),
    ...forProduct("costs", savingsTools()),
    ...forProduct("costs", extendedSupportTools()),
    ...forProduct("costs", seatTools()),
    ...forProduct("costs", carbonTools()),
    ...forProduct("costs", priceCatalogTools()),
    ...forProduct("costs", instancePricingTools()),
    ...forProduct("costs", aiAttributionTools()),
    ...forProduct("costs", networkCostTools()),
    ...momentTools(),
    ...forProduct("automation", workflowTools()),
    ...customGraphTools(),
    ...forProduct("delivery", deploymentTools()),
    ...sshKeyTools(),
    ...sshHostKeyTools(),
    ...linuxAppTools(),
    ...forProduct("security", vulnerabilityTools()),
    ...(await perPluginCreateTools()),
  ];
  cached = tools;
  return tools;
}
