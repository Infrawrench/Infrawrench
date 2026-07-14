/**
 * Orchestrates a single workflow run on the web/cloud side.
 *
 * All runs delegate to the shared `@infrawrench/server-core/workflows/runner`
 * (`runOrgWorkflow`), so web and the poller execute workflows identically.
 * Interactive manual runs (websocket-driven `infra.prompt()`, storage reads,
 * live log streaming, debugger) attach their web-only callbacks through the
 * optional fields on the shared runner's options.
 */
export { runOrgWorkflow as runWorkflowById } from "@infrawrench/server-core/workflows/runner";
