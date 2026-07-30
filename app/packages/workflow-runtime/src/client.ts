/**
 * Sandbox-free entry point.
 *
 * This barrel exposes everything a *host* needs — the {@link WorkflowHost}
 * contract, {@link buildWorkflowHost}, {@link generateInfraDts}, and the shared
 * types — but deliberately omits `runWorkflow`/`transpileWorkflow`, which drag
 * in the QuickJS/WASM sandbox and its memfs dependency (and thus Node's
 * `Buffer`).
 *
 * The desktop renderer imports from here so the sandbox never enters the
 * Chromium bundle; it runs the sandbox in the Electron main process instead
 * (see desktop's electron/workflow-host.ts). Consumers that actually execute
 * workflows in Node (web server, poller, Electron main) import the full barrel
 * (`@infrawrench/workflow-runtime`) instead.
 */
export * from "./types.js";
export * from "./host.js";
export { generateInfraDts, type GenerateInfraDtsInput } from "./codegen.js";
export { buildWorkflowHost, type ClientHostDeps } from "./build-host.js";
export { createFieldsFromConfig } from "./create-fields.js";
export {
  staticResourceCapabilities,
  detailResourceCapabilities,
  clientSupportsImportYaml,
  mergeCapabilities,
} from "./capabilities.js";
export {
  attachSidecarInfo,
  enrichSidecarCapabilities,
  type SidecarCapabilityProbe,
} from "./sidecars.js";
export { generateGraphDts } from "./graphs/codegen.js";
export * from "./graphs/types.js";
