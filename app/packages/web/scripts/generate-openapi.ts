#!/usr/bin/env tsx
/**
 * Build the OpenAPI 3.1 document and write it to `openapi.json`.
 *
 * The spec is built from:
 *   - Hand-written Zod schemas for every route (see `src/api/openapi/paths/*`),
 *   - Plus enums for `pluginId` / `resourceTypeId` sourced from the live plugin
 *     registry via `loadPlugins()` — so the spec always matches the running server.
 *
 * Usage:  pnpm --filter @infrawrench/web generate:openapi
 */
import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../src/api/openapi/index";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "openapi.json");

// Production first: generators take the first server as the client's default
// base URL, and this artifact is what people generate SDKs from. (A running
// server advertises its own origin instead — see `defaultServers()`.)
const doc = await buildOpenApiDocument({
  servers: [
    { url: "https://app.infrawrench.com", description: "Production" },
    { url: "http://localhost:3000", description: "Local dev" },
  ],
});

await writeFile(out, JSON.stringify(doc, null, 2) + "\n");

const pathCount = Object.keys(doc.paths ?? {}).length;
const opCount = Object.values(doc.paths ?? {}).reduce<number>(
  (n, p) =>
    n +
    Object.keys((p ?? {}) as Record<string, unknown>).filter((k) =>
      ["get", "post", "put", "patch", "delete"].includes(k),
    ).length,
  0,
);
console.log(`✓ Wrote ${out}`);
console.log(`  ${pathCount} paths, ${opCount} operations`);
