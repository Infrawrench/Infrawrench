/**
 * `acme/edge-router`: a small TypeScript service, used for every mock
 * repository that is not `infra`.
 */
const mara = { name: "Mara Lindqvist", email: "mara@acme.example" };
const jonas = { name: "Jonas Weber", email: "jonas@acme.example" };

let clock = Date.UTC(2026, 9, 20, 9, 30, 0);
const at = (hours) => {
  clock += Math.round(hours * 3600) * 1000;
  return `${Math.floor(clock / 1000)} +0100`;
};

const packageJson = (version) => `{
  "name": "edge-router",
  "version": "${version}",
  "type": "module",
  "scripts": {
    "build": "tsc -p .",
    "test": "node --test dist"
  },
  "devDependencies": {
    "typescript": "^5.6.0"
  }
}
`;

const router1 = `export interface Route {
  readonly host: string;
  readonly prefix: string;
  readonly upstream: string;
}

export function match(routes: readonly Route[], url: URL): Route | undefined {
  return routes.find((route) => route.host === url.host && url.pathname.startsWith(route.prefix));
}
`;

const router2 = `export interface Route {
  readonly host: string;
  readonly prefix: string;
  readonly upstream: string;
  readonly weight?: number;
}

/** The longest matching prefix wins; ties go to the heavier route. */
export function match(routes: readonly Route[], url: URL): Route | undefined {
  let best: Route | undefined;
  for (const route of routes) {
    if (route.host !== url.host || !url.pathname.startsWith(route.prefix)) continue;
    if (
      best === undefined ||
      route.prefix.length > best.prefix.length ||
      (route.prefix.length === best.prefix.length && (route.weight ?? 1) > (best.weight ?? 1))
    ) {
      best = route;
    }
  }
  return best;
}
`;

const server = `import { createServer } from "node:http";
import { match, type Route } from "./router.js";

const routes: Route[] = JSON.parse(process.env.ROUTES ?? "[]");

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", \`http://\${request.headers.host}\`);
  const route = match(routes, url);
  if (route === undefined) {
    response.writeHead(404).end("no route\\n");
    return;
  }
  const upstream = await fetch(new URL(url.pathname + url.search, route.upstream), {
    method: request.method,
    headers: { "x-forwarded-host": url.host },
  });
  response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
  response.end(Buffer.from(await upstream.arrayBuffer()));
}).listen(Number(process.env.PORT ?? 8080));
`;

const readme = `# edge-router

Routes requests at the edge by host and path prefix.

\`\`\`sh
ROUTES='[{"host":"api.acme.example","prefix":"/","upstream":"http://10.0.3.14:8080"}]' node dist/server.js
\`\`\`
`;

const tsconfig = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "outDir": "dist",
    "strict": true
  },
  "include": ["src"]
}
`;

const steps = [];
const commit = (by, hours, message, files) => steps.push({ by, at: at(hours), message, files });

commit(mara, 0, "Initial commit", {
  "README.md": readme,
  "package.json": packageJson("0.1.0"),
  "tsconfig.json": tsconfig,
  ".gitignore": "node_modules/\ndist/\n",
});
commit(mara, 3, "Match routes by host and prefix", { "src/router.ts": router1 });
commit(jonas, 21, "Serve over HTTP", { "src/server.ts": server });
steps.push({ tag: "v0.1.0" });
commit(jonas, 46, "Prefer the longest prefix, then the heavier route", {
  "src/router.ts": router2,
  "package.json": packageJson("0.2.0"),
});
steps.push({ tag: "v0.2.0" });
steps.push({ checkout: "feature/health-checks", create: true });
commit(mara, 30, "Skip upstreams that fail their health check", {
  "src/health.ts": `const failing = new Set<string>();

export function markFailing(upstream: string): void {
  failing.add(upstream);
}

export function markHealthy(upstream: string): void {
  failing.delete(upstream);
}

export function isHealthy(upstream: string): boolean {
  return !failing.has(upstream);
}
`,
});
steps.push({ checkout: "main" });
// Work done with coding tools: their addresses resolve to the forge's bot accounts.
commit(
  jonas,
  50,
  "Answer 404 for a host with no routes\n\nA request for an unknown host fell through to the first route.\n\nCo-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>",
  { "src/router.ts": `${router2}\nexport const NO_ROUTE = 404;\n` },
);
commit(
  { name: "Cursor Agent", email: "cursoragent@cursor.com" },
  52,
  "Document the route weights\n\nCo-authored-by: Mara Lindqvist <mara@acme.example>",
  { "README.md": `${readme}\nRoutes with the same prefix are ordered by weight.\n` },
);
commit(
  mara,
  54,
  "Log the route a request took\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\nCo-authored-by: Claude <noreply@anthropic.com>",
  { "src/server.ts": `${server}\nexport const LOG_ROUTES = true;\n` },
);

export const history = { defaultBranch: "main", steps };
