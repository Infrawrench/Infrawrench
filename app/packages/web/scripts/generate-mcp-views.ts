/**
 * Regenerate `src/mcp/app-views.gen.ts`, the MCP Apps views' HTML, from
 * `src/mcp/views/`. Run after changing a view; `app-views.test.ts` fails
 * until you do.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderMcpViewsModule } from "../src/mcp/app-views-build";

const target = fileURLToPath(new URL("../src/mcp/app-views.gen.ts", import.meta.url));
writeFileSync(target, await renderMcpViewsModule());
console.log(`wrote ${target}`);
