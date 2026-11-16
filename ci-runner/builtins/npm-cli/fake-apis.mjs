// Fake Vercel, Cloudflare and Neon APIs for the npm CLI builtins' tests
// (test.sh's `npm-cli` pipeline): no request ever leaves the job. Each API
// listens on its own port of the job's loopback and answers the routes the
// CLIs' deploy and branch commands use, with the shapes their public API
// references and the CLIs' own sources describe. A request without the
// expected bearer token gets the API's 401 or 403. Anything else is a 404
// that names the route, so a CLI that starts asking for something new
// fails its test loudly.
//
//   node fake-apis.mjs   (VERCEL_PORT 4100, CLOUDFLARE_PORT 4200, NEON_PORT 4300)
//
// `GET /_received` on any of them returns what it was sent (deployed
// files, scripts, branches), for a test to check.
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const TOKENS = {
  vercel: process.env.FAKE_VERCEL_TOKEN ?? "vercelfixturetoken0451",
  cloudflare: process.env.FAKE_CLOUDFLARE_TOKEN ?? "cloudflare-fixture-token-0451",
  neon: process.env.FAKE_NEON_TOKEN ?? "neon-fixture-key-0451",
};
const received = { vercel: [], cloudflare: [], neon: [] };

function body(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function serve(api, port, routes, unauthorized) {
  createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const data = await body(req);
    const auth = req.headers.authorization ?? "";
    console.log(
      `${api} ${req.method} ${url.pathname}${url.search} auth=${auth === `Bearer ${TOKENS[api]}` ? "ok" : auth ? "wrong" : "none"}`,
    );
    if (url.pathname === "/_received") return json(res, 200, received[api]);
    for (const [method, pattern, handler, open] of routes) {
      const match = method === req.method && url.pathname.match(pattern);
      if (!match) continue;
      if (!open && auth !== `Bearer ${TOKENS[api]}`) return unauthorized(res);
      try {
        return await handler({ req, res, url, data, params: match.slice(1) });
      } catch (e) {
        console.log(`${api} handler error: ${e.stack}`);
        return json(res, 500, { error: String(e) });
      }
    }
    json(res, 404, {
      error: { code: "not_found", message: `fake ${api} has no ${req.method} ${url.pathname}` },
    });
  }).listen(port, "127.0.0.1", () => console.log(`fake ${api} API listening on ${port}`));
}

// Vercel (https://vercel.com/docs/rest-api): a linked project, file
// uploads by SHA-1, deployments that are ready at once.
const vercelFiles = new Map();
const vercelDeployments = new Map();
function vercelDeployment(id, body) {
  return {
    id,
    url: `${body.name ?? "web"}-${id.slice(4, 12)}.vercel.app`,
    name: body.name ?? "web",
    readyState: "READY",
    readySubstate: "PROMOTED",
    status: "READY",
    target: body.target ?? null,
    alias: body.target === "production" ? ["web.example.com"] : [],
    aliasAssigned: true,
    aliasError: null,
    createdAt: Date.now(),
    buildingAt: Date.now(),
    ready: Date.now(),
    projectId: "prj_fixture",
    ownerId: "team_fixture",
    inspectorUrl: `https://vercel.com/acme/web/${id}`,
    creator: { uid: "user_fixture", username: "ci" },
    team: { id: "team_fixture", slug: "acme", name: "Acme" },
    regions: ["iad1"],
    meta: {},
    routes: null,
    version: 2,
  };
}
const vercelProject = {
  id: "prj_fixture",
  name: "web",
  accountId: "team_fixture",
  framework: null,
  rootDirectory: null,
  nodeVersion: "24.x",
  buildCommand: null,
  devCommand: null,
  installCommand: null,
  outputDirectory: null,
  directoryListing: false,
  createdAt: 1,
  updatedAt: 1,
  link: null,
  latestDeployments: [],
  targets: {},
  env: [],
  settings: {},
};
serve(
  "vercel",
  Number(process.env.VERCEL_PORT ?? 4100),
  [
    [
      "GET",
      /^\/v2\/user$/,
      ({ res }) =>
        json(res, 200, {
          user: {
            id: "user_fixture",
            uid: "user_fixture",
            username: "ci",
            email: "ci@example.com",
            name: "CI",
            defaultTeamId: "team_fixture",
            version: "northstar",
          },
        }),
    ],
    [
      "GET",
      /^(?:\/v2)?\/teams\/([^/]+)$/,
      ({ res, params }) => json(res, 200, { id: params[0], slug: "acme", name: "Acme" }),
    ],
    [
      "GET",
      /^\/v1\/teams$/,
      ({ res }) =>
        json(res, 200, {
          teams: [{ id: "team_fixture", slug: "acme", name: "Acme" }],
          pagination: { count: 1, next: null, prev: null },
        }),
    ],
    [
      "GET",
      /^\/v(?:9|10|1)\/projects\/([^/]+)$/,
      ({ res, params }) =>
        params[0] === "prj_fixture" || params[0] === "web"
          ? json(res, 200, vercelProject)
          : json(res, 404, { error: { code: "not_found", message: "Project not found" } }),
    ],
    [
      "GET",
      /^\/v1\/projects\/[^/]+\/custom-environments$/,
      ({ res }) => json(res, 200, { environments: [] }),
    ],
    [
      "POST",
      /^\/v2\/files$/,
      ({ req, res, data }) => {
        // The CLI names the SHA-1 in `x-now-digest`; the API documents `x-vercel-digest`.
        const digest = req.headers["x-vercel-digest"] ?? req.headers["x-now-digest"];
        const sha = createHash("sha1").update(data).digest("hex");
        if (digest !== sha)
          return json(res, 400, {
            error: { code: "invalid_digest", message: `digest ${digest} is not ${sha}` },
          });
        vercelFiles.set(sha, data);
        json(res, 200, { urls: [] });
      },
    ],
    [
      "POST",
      /^\/v13\/deployments$/,
      ({ res, url, data }) => {
        const body = JSON.parse(data.toString() || "{}");
        const missing = (body.files ?? [])
          .map((f) => f.sha)
          .filter((sha) => sha && !vercelFiles.has(sha));
        if (missing.length > 0) {
          return json(res, 400, {
            error: { code: "missing_files", message: "Missing files", missing },
          });
        }
        const id = `dpl_${createHash("sha1").update(data).digest("hex").slice(0, 24)}`;
        const deployment = vercelDeployment(id, body);
        vercelDeployments.set(id, deployment);
        received.vercel.push({
          deployment: id,
          name: body.name,
          target: body.target ?? null,
          prebuilt: url.searchParams.get("prebuilt") === "1",
          project: body.project ?? null,
          // Small files come inline (`data`), the rest by SHA-1 after an upload.
          files: Object.fromEntries(
            (body.files ?? []).map((f) => [
              f.file,
              f.data !== undefined
                ? Buffer.from(f.data, f.encoding === "base64" ? "base64" : "utf8").toString("utf8")
                : (vercelFiles.get(f.sha)?.toString("utf8") ?? null),
            ]),
          ),
          uploaded: [...vercelFiles.keys()].length,
        });
        json(res, 200, deployment);
      },
    ],
    [
      "GET",
      /^\/v1[13]\/(?:now\/)?deployments\/([^/]+)$/,
      ({ res, params }) => {
        const d =
          vercelDeployments.get(params[0]) ??
          [...vercelDeployments.values()].find((x) => x.url === params[0]);
        return d
          ? json(res, 200, d)
          : json(res, 404, { error: { code: "not_found", message: "Deployment not found" } });
      },
    ],
    ["GET", /^\/v3\/deployments\/([^/]+)\/events$/, ({ res }) => json(res, 200, [])],
    ["GET", /^\/v2\/deployments\/([^/]+)\/aliases$/, ({ res }) => json(res, 200, { aliases: [] })],
  ],
  (res) =>
    json(res, 403, { error: { code: "forbidden", message: "Not authorized", invalidToken: true } }),
);

// Cloudflare (https://developers.cloudflare.com/api/): Workers scripts
// with a workers.dev subdomain, Workers static assets, and Pages direct
// uploads, for one account.
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const cf = (result, extra = {}) => ({ success: true, errors: [], messages: [], result, ...extra });
const cfError = (status, code, message) => (res) =>
  json(res, status, { success: false, errors: [{ code, message }], messages: [], result: null });
const scripts = new Map();
// Wrangler reads an upload token's expiry from its payload, so it is
// shaped like a JWT; nothing checks a signature.
const jwt = (claims) =>
  [{ alg: "none", typ: "JWT" }, claims, "fixture"]
    .map((part) =>
      Buffer.from(typeof part === "string" ? part : JSON.stringify(part)).toString("base64url"),
    )
    .join(".");
const PAGES_JWT = jwt({ exp: 4102444800, sub: "pages-upload" });
const pagesHashes = new Set();
function multipartParts(req, data) {
  const type = req.headers["content-type"] ?? "";
  const boundary = type.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (!boundary) return [];
  const sep = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const parts = [];
  let at = data.indexOf(sep);
  while (at !== -1) {
    const next = data.indexOf(sep, at + sep.length);
    if (next === -1) break;
    const part = data.subarray(at + sep.length + 2, next - 2);
    const split = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, split).toString();
    parts.push({
      name: head.match(/name="([^"]*)"/)?.[1],
      filename: head.match(/filename="([^"]*)"/)?.[1],
      body: part.subarray(split + 4),
    });
    at = next;
  }
  return parts;
}
const acc = (rest) => new RegExp(`^/client/v4/accounts/${ACCOUNT}${rest}$`);
serve(
  "cloudflare",
  Number(process.env.CLOUDFLARE_PORT ?? 4200),
  [
    [
      "GET",
      /^\/client\/v4\/user\/tokens\/verify$/,
      ({ res }) => json(res, 200, cf({ id: "tok", status: "active" })),
    ],
    [
      "GET",
      /^\/client\/v4\/memberships$/,
      ({ res }) =>
        json(
          res,
          200,
          cf([{ id: "m", account: { id: ACCOUNT, name: "Acme" }, status: "accepted" }]),
        ),
    ],
    [
      "GET",
      /^\/client\/v4\/accounts$/,
      ({ res }) => json(res, 200, cf([{ id: ACCOUNT, name: "Acme" }])),
    ],
    ["GET", acc("/workers/subdomain"), ({ res }) => json(res, 200, cf({ subdomain: "acme" }))],
    [
      "GET",
      acc("/workers/services/([^/]+)"),
      ({ res, params }) =>
        scripts.has(params[0])
          ? json(
              res,
              200,
              cf({
                id: params[0],
                default_environment: {
                  environment: "production",
                  script: {
                    id: params[0],
                    tag: "t",
                    etag: "e",
                    handlers: ["fetch"],
                    last_deployed_from: "wrangler",
                  },
                },
              }),
            )
          : cfError(404, 10090, "This Worker does not exist on your account.")(res),
    ],
    [
      "GET",
      acc("/workers/scripts/([^/]+)/settings"),
      ({ res }) =>
        json(
          res,
          200,
          cf({
            bindings: [],
            compatibility_date: "2026-11-01",
            compatibility_flags: [],
            placement: {},
            tags: [],
            tail_consumers: [],
            observability: null,
            logpush: false,
          }),
        ),
    ],
    [
      "PUT",
      acc("/workers/scripts/([^/]+)"),
      ({ req, res, data, params }) => {
        const parts = multipartParts(req, data);
        const metadata = JSON.parse(
          parts.find((p) => p.name === "metadata")?.body.toString() ?? "{}",
        );
        const modules = Object.fromEntries(
          parts.filter((p) => p.name !== "metadata").map((p) => [p.name, p.body.toString("utf8")]),
        );
        scripts.set(params[0], { metadata, modules });
        received.cloudflare.push({
          worker: params[0],
          main_module: metadata.main_module ?? null,
          assets: Boolean(metadata.assets),
          modules,
        });
        json(
          res,
          200,
          cf(
            {
              id: params[0],
              etag: "etag",
              tag: "tag",
              deployment_id: "dep-1",
              has_assets: Boolean(metadata.assets),
              has_modules: true,
              startup_time_ms: 1,
              handlers: ["fetch"],
            },
            {},
          ),
        );
      },
    ],
    // The Workers resource of the newer API: wrangler reads the workers.dev
    // subdomain's state from it, and sets it with PATCH.
    [
      "GET",
      acc("/workers/workers/([^/]+)"),
      ({ res, params }) =>
        json(
          res,
          200,
          cf({
            id: params[0],
            name: params[0],
            subdomain: { enabled: true, previews_enabled: true },
            observability: { enabled: false },
          }),
        ),
    ],
    [
      "PATCH",
      acc("/workers/workers/([^/]+)"),
      ({ res, params }) =>
        json(
          res,
          200,
          cf({
            id: params[0],
            name: params[0],
            subdomain: { enabled: true, previews_enabled: true },
          }),
        ),
    ],
    [
      "GET",
      acc("/workers/scripts/([^/]+)/subdomain"),
      ({ res }) => json(res, 200, cf({ enabled: true, previews_enabled: true })),
    ],
    [
      "POST",
      acc("/workers/scripts/([^/]+)/subdomain"),
      ({ res }) => json(res, 200, cf({ enabled: true, previews_enabled: true })),
    ],
    [
      "GET",
      acc("/workers/services/([^/]+)/environments/production/subdomain"),
      ({ res }) => json(res, 200, cf({ enabled: true, previews_enabled: true })),
    ],
    [
      "POST",
      acc("/workers/services/([^/]+)/environments/production/subdomain"),
      ({ res }) => json(res, 200, cf({ enabled: true, previews_enabled: true })),
    ],
    [
      "GET",
      acc("/workers/scripts/([^/]+)/schedules"),
      ({ res }) => json(res, 200, cf({ schedules: [] })),
    ],
    [
      "PUT",
      acc("/workers/scripts/([^/]+)/schedules"),
      ({ res }) => json(res, 200, cf({ schedules: [] })),
    ],
    ["GET", acc("/workers/scripts/([^/]+)/routes"), ({ res }) => json(res, 200, cf([]))],
    [
      "GET",
      acc("/workers/deployments/by-script/([^/]+)"),
      ({ res }) => json(res, 200, cf({ latest: { id: "dep-1", number: 1 } })),
    ],
    [
      "GET",
      acc("/workers/scripts/([^/]+)/deployments"),
      ({ res }) => json(res, 200, cf({ deployments: [] })),
    ],
    [
      "POST",
      acc("/workers/scripts/([^/]+)/deployments"),
      ({ res }) => json(res, 200, cf({ id: "dep-2" })),
    ],
    [
      "GET",
      acc("/workers/scripts/([^/]+)/versions"),
      ({ res }) => json(res, 200, cf({ items: [] })),
    ],
    // Workers static assets: one bucket, every file missing the first time.
    [
      "POST",
      acc("/workers/scripts/([^/]+)/assets-upload-session"),
      ({ res, data }) => {
        const manifest = JSON.parse(data.toString() || "{}").manifest ?? {};
        const hashes = Object.values(manifest).map((f) => f.hash);
        json(res, 200, cf({ jwt: "assets-upload-jwt", buckets: hashes.length ? [hashes] : [] }));
      },
    ],
    [
      "POST",
      acc("/workers/assets/upload"),
      ({ req, res }) =>
        req.headers.authorization === "Bearer assets-upload-jwt"
          ? json(res, 201, cf({ jwt: "assets-completion-jwt" }))
          : cfError(401, 10000, "bad assets upload JWT")(res),
      true,
    ],
    // Pages: a project, an upload token, content-addressed assets.
    [
      "GET",
      acc("/pages/projects/([^/]+)"),
      ({ res, params }) =>
        json(
          res,
          200,
          cf({
            id: "pages-1",
            name: params[0],
            subdomain: `${params[0]}.pages.dev`,
            production_branch: "main",
            deployment_configs: { production: {}, preview: {} },
          }),
        ),
    ],
    [
      "GET",
      acc("/pages/projects/([^/]+)/upload-token"),
      ({ res }) => json(res, 200, cf({ jwt: PAGES_JWT })),
    ],
    [
      "POST",
      /^\/client\/v4\/pages\/assets\/check-missing$/,
      ({ req, res, data }) => {
        if (req.headers.authorization !== `Bearer ${PAGES_JWT}`)
          return cfError(401, 8000000, "bad upload JWT")(res);
        json(res, 200, cf(JSON.parse(data.toString()).hashes.filter((h) => !pagesHashes.has(h))));
      },
      true,
    ],
    [
      "POST",
      /^\/client\/v4\/pages\/assets\/upload$/,
      ({ req, res, data }) => {
        if (req.headers.authorization !== `Bearer ${PAGES_JWT}`)
          return cfError(401, 8000000, "bad upload JWT")(res);
        for (const file of JSON.parse(data.toString())) pagesHashes.add(file.key);
        json(res, 200, cf({ successful_key_count: 1, unsuccessful_keys: [] }));
      },
      true,
    ],
    [
      "POST",
      /^\/client\/v4\/pages\/assets\/upsert-hashes$/,
      ({ res }) => json(res, 200, cf(null)),
      true,
    ],
    [
      "GET",
      acc("/pages/projects/([^/]+)/deployments/([^/]+)"),
      ({ res, params }) =>
        json(
          res,
          200,
          cf({
            id: params[1],
            url: `https://abc123.${params[0]}.pages.dev`,
            environment: "production",
            project_name: params[0],
            latest_stage: { name: "deploy", status: "success" },
            stages: [],
            aliases: [],
          }),
        ),
    ],
    [
      "POST",
      acc("/pages/projects/([^/]+)/deployments"),
      ({ req, res, data, params }) => {
        const parts = multipartParts(req, data);
        const manifest = JSON.parse(
          parts.find((p) => p.name === "manifest")?.body.toString() ?? "{}",
        );
        received.cloudflare.push({
          pages: params[0],
          branch: parts.find((p) => p.name === "branch")?.body.toString() ?? null,
          files: Object.keys(manifest).sort(),
        });
        json(
          res,
          200,
          cf({
            id: "pages-dep-1",
            url: `https://abc123.${params[0]}.pages.dev`,
            environment: "production",
            project_name: params[0],
            latest_stage: { name: "deploy", status: "success" },
            stages: [],
            deployment_trigger: { type: "ad_hoc" },
          }),
        );
      },
    ],
  ],
  cfError(403, 10000, "Authentication error"),
);

// Neon (https://api-docs.neon.tech/reference): one project with a main
// branch; branches made here get an endpoint, the owner role and a
// database, and their operations are finished at once.
const PROJECT = "fixture-project-123456";
const branches = new Map([
  [
    "br-main-000001",
    {
      id: "br-main-000001",
      name: "main",
      project_id: PROJECT,
      default: true,
      primary: true,
      current_state: "ready",
      created_at: "2026-11-01T00:00:00Z",
      updated_at: "2026-11-01T00:00:00Z",
    },
  ],
]);
const endpointOf = (b) => ({
  id: `ep-${b.id.slice(3)}`,
  host: `ep-${b.id.slice(3)}.fake.neon.test`,
  branch_id: b.id,
  project_id: PROJECT,
  type: "read_write",
  current_state: "active",
  pooler_enabled: false,
  region_id: "aws-us-east-2",
  autoscaling_limit_min_cu: 0.25,
  autoscaling_limit_max_cu: 1,
  created_at: b.created_at,
  updated_at: b.created_at,
  suspend_timeout_seconds: 0,
  settings: {},
});
const op = (b, action) => ({
  id: `op-${action}-${b.id}`,
  project_id: PROJECT,
  branch_id: b.id,
  action,
  status: "finished",
  failures_count: 0,
  created_at: b.created_at,
  updated_at: b.created_at,
  total_duration_ms: 1,
});
const branchRoute = (rest) => new RegExp(`^/api/v2/projects/${PROJECT}/branches/([^/]+)${rest}$`);
const withBranch = (handler) => (ctx) => {
  const b = branches.get(ctx.params[0]);
  return b ? handler(b, ctx) : json(ctx.res, 404, { code: "", message: "branch not found" });
};
serve(
  "neon",
  Number(process.env.NEON_PORT ?? 4300),
  [
    [
      "GET",
      /^\/api\/v2\/projects$/,
      ({ res }) =>
        json(res, 200, {
          projects: [
            { id: PROJECT, name: "fixture", region_id: "aws-us-east-2", org_id: "org-fixture" },
          ],
          pagination: {},
        }),
    ],
    [
      "GET",
      new RegExp(`^/api/v2/projects/${PROJECT}$`),
      ({ res }) =>
        json(res, 200, {
          project: {
            id: PROJECT,
            name: "fixture",
            region_id: "aws-us-east-2",
            default_endpoint_settings: {},
            org_id: "org-fixture",
            pg_version: 17,
          },
        }),
    ],
    [
      "GET",
      new RegExp(`^/api/v2/projects/${PROJECT}/branches$`),
      ({ res }) => json(res, 200, { branches: [...branches.values()], annotations: {} }),
    ],
    [
      "POST",
      new RegExp(`^/api/v2/projects/${PROJECT}/branches$`),
      ({ res, data }) => {
        const body = JSON.parse(data.toString() || "{}");
        const n = String(branches.size + 1).padStart(6, "0");
        const b = {
          id: `br-made-${n}`,
          name: body.branch?.name ?? `br-${n}`,
          parent_id: body.branch?.parent_id ?? "br-main-000001",
          project_id: PROJECT,
          default: false,
          primary: false,
          current_state: "ready",
          created_at: "2026-11-02T00:00:00Z",
          updated_at: "2026-11-02T00:00:00Z",
        };
        branches.set(b.id, b);
        received.neon.push({ created: b.name });
        const endpoint = endpointOf(b);
        json(res, 201, {
          branch: b,
          endpoints: [endpoint],
          operations: [op(b, "create_branch")],
          roles: [{ branch_id: b.id, name: "app_owner", protected: false }],
          databases: [{ id: 1, branch_id: b.id, name: "app", owner_name: "app_owner" }],
          connection_uris: [
            {
              connection_uri: `postgresql://app_owner:fixture-password-0451@${endpoint.host}/app?sslmode=require`,
              connection_parameters: {
                database: "app",
                password: "fixture-password-0451",
                role: "app_owner",
                host: endpoint.host,
                pooler_host: endpoint.host,
              },
            },
          ],
        });
      },
    ],
    [
      "GET",
      branchRoute(""),
      withBranch((b, { res }) => json(res, 200, { branch: b, annotation: null })),
    ],
    [
      "DELETE",
      branchRoute(""),
      withBranch((b, { res }) => {
        branches.delete(b.id);
        received.neon.push({ deleted: b.name });
        json(res, 200, { branch: b, operations: [op(b, "delete_timeline")] });
      }),
    ],
    [
      "GET",
      branchRoute("/endpoints"),
      withBranch((b, { res }) => json(res, 200, { endpoints: [endpointOf(b)] })),
    ],
    [
      "GET",
      branchRoute("/roles"),
      withBranch((b, { res }) =>
        json(res, 200, {
          roles: [
            {
              branch_id: b.id,
              name: "app_owner",
              protected: false,
              created_at: b.created_at,
              updated_at: b.created_at,
            },
          ],
        }),
      ),
    ],
    [
      "GET",
      branchRoute("/databases"),
      withBranch((b, { res }) =>
        json(res, 200, {
          databases: [
            {
              id: 1,
              branch_id: b.id,
              name: "app",
              owner_name: "app_owner",
              created_at: b.created_at,
              updated_at: b.created_at,
            },
          ],
        }),
      ),
    ],
    [
      "GET",
      branchRoute("/roles/([^/]+)/reveal_password"),
      withBranch((b, { res }) => json(res, 200, { password: "fixture-password-0451" })),
    ],
    [
      "GET",
      new RegExp(`^/api/v2/projects/${PROJECT}/operations/([^/]+)$`),
      ({ res, params }) =>
        json(res, 200, {
          operation: {
            id: params[0],
            status: "finished",
            action: "create_branch",
            project_id: PROJECT,
          },
        }),
    ],
  ],
  (res) => json(res, 401, { code: "", message: "authentication required" }),
);
