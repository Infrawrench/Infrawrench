#!/usr/bin/env tsx
/**
 * Build the OpenAPI 3.1 document and write it to `openapi.json`.
 *
 * The spec is built from:
 *   - Hand-written Zod schemas for every route (see `src/api/openapi/paths/*`),
 *   - Plus enums for `pluginId` / `resourceTypeId` sourced from the live plugin
 *     registry via `loadPlugins()` — so the spec always matches the running server.
 *
 * Then the client SDKs are refreshed from it, but only if they're out of date —
 * see `./sdk/generate.ts`. To rebuild them on their own, use `generate:sdk`.
 *
 * Usage:  pnpm --filter @infrawrench/web generate:openapi
 */
import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../src/api/openapi/index";
import { generateSdks } from "./sdk/generate";
import { SPEC_SERVERS } from "./spec-servers";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "openapi.json");

const doc = await buildOpenApiDocument({ servers: [...SPEC_SERVERS] });

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

await generateSdks({ document: doc, log: (message) => console.log(message) });
