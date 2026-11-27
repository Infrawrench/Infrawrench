/**
 * `cloudflare:workers` for a package that imports Cloudflare's types by name
 * (`@cloudflare/workers-types/index`) rather than globally, which is what
 * keeps them from clashing with `@types/node` (KNOWLEDGE.md "Edge/gateway
 * split"). The importable flavour declares the module's contents but not
 * the module, so this names the one class the worker extends.
 */
declare module "cloudflare:workers" {
  import type { CloudflareWorkersModule } from "@cloudflare/workers-types/index";

  export const DurableObject: typeof CloudflareWorkersModule.DurableObject;
  export type DurableObject<Env = unknown> = CloudflareWorkersModule.DurableObject<Env>;
}

/**
 * Modules of the upload that are not code (`rules` in wrangler.jsonc): a
 * `.wasm` file is a module Cloudflare compiles when the Worker is deployed,
 * and a `.woff` font is its bytes. The link preview renderer reads both
 * (`og/assets.ts`).
 */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "*.woff" {
  const data: ArrayBuffer;
  export default data;
}
