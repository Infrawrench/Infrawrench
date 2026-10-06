/**
 * Regenerate `src/plugin-registry-edge.gen.json`, the metadata-only plugin
 * registry the web edge Worker loads instead of the plugins themselves (see
 * `src/plugin-loader.ts`). Run after changing any plugin's manifest or
 * resource types; `edge-plugin-registry.test.ts` fails until you do.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUNDLED_PLUGINS } from "../src/plugin-registry";
import { serializePluginsForEdge } from "../src/plugin-registry-edge-format";

const target = fileURLToPath(new URL("../src/plugin-registry-edge.gen.json", import.meta.url));
writeFileSync(target, JSON.stringify(serializePluginsForEdge(BUNDLED_PLUGINS)) + "\n");
console.log(`wrote ${BUNDLED_PLUGINS.length} plugins to ${target}`);
