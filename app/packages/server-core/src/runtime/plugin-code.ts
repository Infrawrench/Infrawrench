/**
 * Whether plugin code is in this bundle, as its own module with no imports.
 *
 * `plugin-loader.ts` re-exports `pluginCodeAvailable`, and code that loads
 * plugins takes it from there. Code that only asks the question (CI's
 * dispatcher, which leaves a run that lends something for the gateway) takes
 * it from here, so asking does not put the loader, and through it the
 * metadata registry (3.5 MB), in a bundle that never loads a plugin. The
 * forge's Worker (`git/packages/worker`) is that bundle: its
 * `src/__tests__/import-graph.test.ts` fails when its graph reaches the
 * loader again.
 */

declare global {
  /**
   * Defined `true` at build time by the Workers that carry no plugin code
   * (the web edge Worker and the forge's, in their wrangler.jsonc `define`).
   * Never set at runtime.
   */
  var __INFRAWRENCH_EDGE_PLUGINS__: boolean | undefined;
}

/**
 * Whether plugin *code* can run in this process. False only in a Worker built
 * with `__INFRAWRENCH_EDGE_PLUGINS__`, whose registry (if it has one) is
 * manifests with stub functions. Code that would otherwise call a plugin
 * inline (a paging send on the alert path) checks this and leaves the work for
 * a gateway pass instead, rather than tripping the gateway-only error
 * mid-request after it has already written to the database.
 */
export function pluginCodeAvailable(): boolean {
  return !globalThis.__INFRAWRENCH_EDGE_PLUGINS__;
}
