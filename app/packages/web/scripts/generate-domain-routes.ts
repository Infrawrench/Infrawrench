/**
 * Regenerate `src/http/domain-routes.gen.ts`, the routes each API domain
 * registers and a loader per domain, which the edge Worker routes with
 * (`src/api/edge.ts`). Run after adding, removing or changing a domain's
 * routes; `src/http/__tests__/domain-routes.test.ts` fails until you do.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Loading the domains reads these at import; no request is made.
process.env["WORKOS_API_KEY"] ??= "sk_test_generate_domain_routes";
process.env["WORKOS_CLIENT_ID"] ??= "client_generate_domain_routes";

const { renderDomainRoutesModule } = await import("../src/http/domain-routes-build");
const target = fileURLToPath(new URL("../src/http/domain-routes.gen.ts", import.meta.url));
writeFileSync(target, await renderDomainRoutesModule());
console.log(`wrote ${target}`);
process.exit(0);
