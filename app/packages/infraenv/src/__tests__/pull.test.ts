import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderDotenv } from "@infrawrench/client-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  KEY,
  ORG,
  OTHER_ORG,
  cleanupTempDirs,
  gitInit,
  isolateGit,
  mockApi,
  runCli,
  whoamiRoute,
  type MockApi,
} from "./harness";

const INFRAENV = `[vars]
stage = dev

[env]
NODE_ENV = development
DATABASE_URL = resource("neon/neon-branch", "storefront / \${stage}", "connectionString")
STRIPE_SECRET_KEY = secret("STRIPE_SECRET_KEY")

[env.production]
NODE_ENV = production
`;

const SECRET_VALUE = "sk_fake_value_for_tests";

const resolveRoute = (org = ORG) => ({
  [`POST /api/org/${org}/env-files/resolve`]: (request: { body: unknown }) => {
    const body = request.body as { environment?: string };
    const values = [
      { key: "NODE_ENV", value: body.environment === "production" ? "production" : "development" },
      { key: "DATABASE_URL", value: "postgres://fake@db.invalid/app" },
      { key: "STRIPE_SECRET_KEY", value: SECRET_VALUE },
    ];
    return {
      status: 200,
      body: {
        environment: body.environment ?? null,
        values,
        problems: [],
        dotenv: renderDotenv(values, { environment: body.environment ?? null }),
      },
    };
  },
});

let api: MockApi;

beforeAll(isolateGit);
afterEach(async () => api?.close());
afterAll(cleanupTempDirs);

function project(text = INFRAENV): string {
  const root = gitInit();
  writeFileSync(join(root, ".infraenv"), text);
  writeFileSync(join(root, ".gitignore"), ".env\n");
  return root;
}

const env = () => ({ INFRAWRENCH_API_KEY: KEY, INFRAWRENCH_BASE_URL: api.url });

describe("infraenv pull", () => {
  it("resolves in the key's organization and writes .env with mode 0600", async () => {
    api = await mockApi({ "GET /api/v1/whoami": whoamiRoute(), ...resolveRoute() });
    const root = project();
    mkdirSync(join(root, "src"));
    const result = await runCli(["pull", "-e", "production", "--var", "stage=prod"], {
      cwd: join(root, "src"),
      env: env(),
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toBe("Wrote ../.env (3 variables, environment production)\n");
    expect(result.out).not.toContain(SECRET_VALUE);

    const written = readFileSync(join(root, ".env"), "utf8");
    expect(written).toContain(`STRIPE_SECRET_KEY=${SECRET_VALUE}`);
    expect(statSync(join(root, ".env")).mode & 0o777).toBe(0o600);

    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/v1/whoami",
      `POST /api/org/${ORG}/env-files/resolve`,
    ]);
    const resolve = api.requests[1]!;
    expect(resolve.authorization).toBe(`Bearer ${KEY}`);
    expect(resolve.body).toEqual({
      source: INFRAENV,
      environment: "production",
      vars: { stage: "prod" },
      sourceName: ".infraenv",
    });
  });

  it("uses --org without asking whoami, and the file's output setting", async () => {
    api = await mockApi(resolveRoute(OTHER_ORG));
    const root = project(`[infrawrench]\noutput = config/.env.local\n\n${INFRAENV}`);
    const result = await runCli(["pull", "--org", OTHER_ORG, "-q"], { cwd: root, env: env() });
    expect(result.code).toBe(0);
    expect(result.out).toBe("");
    expect(existsSync(join(root, "config", ".env.local"))).toBe(true);
    expect(api.requests.map((r) => r.path)).toEqual([`/api/org/${OTHER_ORG}/env-files/resolve`]);
    expect((api.requests[0]!.body as { sourceName: string }).sourceName).toBe("../.infraenv");
  });

  it("refuses to replace a hand-written .env without --force, and replaces a generated one", async () => {
    api = await mockApi({ "GET /api/v1/whoami": whoamiRoute(), ...resolveRoute() });
    const root = project();
    writeFileSync(join(root, ".env"), "MINE=1\n", { mode: 0o644 });
    const refused = await runCli(["pull"], { cwd: root, env: env() });
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/\.env exists and looks hand-written/);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("MINE=1\n");
    expect(api.requests).toEqual([]);

    const forced = await runCli(["pull", "--force"], { cwd: root, env: env() });
    expect(forced.code).toBe(0);
    expect(statSync(join(root, ".env")).mode & 0o777).toBe(0o600);

    // Now it carries the generated header, so a plain pull replaces it.
    const again = await runCli(["pull"], { cwd: root, env: env() });
    expect(again.code).toBe(0);
  });

  it("prints problems by line and exits 1, still writing what resolved", async () => {
    api = await mockApi({
      "GET /api/v1/whoami": whoamiRoute(),
      [`POST /api/org/${ORG}/env-files/resolve`]: () => ({
        status: 200,
        body: {
          environment: null,
          values: [{ key: "NODE_ENV", value: "development" }],
          problems: [
            { line: 6, key: "DATABASE_URL", message: "Resource not found" },
            { line: 7, key: "STRIPE_SECRET_KEY", message: "No such secret" },
          ],
          dotenv: renderDotenv([{ key: "NODE_ENV", value: "development" }]),
        },
      }),
    });
    const root = project();
    const result = await runCli(["pull"], { cwd: root, env: env() });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      [
        ".infraenv:6 DATABASE_URL: Resource not found",
        ".infraenv:7 STRIPE_SECRET_KEY: No such secret",
        "2 variables did not resolve and were left out.",
        "",
      ].join("\n"),
    );
    expect(readFileSync(join(root, ".env"), "utf8")).toContain("NODE_ENV=development");
  });

  it("prints the .env with --stdout and the whole response with --json", async () => {
    api = await mockApi({ "GET /api/v1/whoami": whoamiRoute(), ...resolveRoute() });
    const root = project();
    const printed = await runCli(["pull", "--stdout"], { cwd: root, env: env() });
    expect(printed.code).toBe(0);
    expect(printed.out).toContain("# Auto-generated by Infrawrench. Do not edit.");
    expect(existsSync(join(root, ".env"))).toBe(false);

    const json = await runCli(["pull", "--json"], { cwd: root, env: env() });
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.out) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      org: ORG,
      file: join(root, ".infraenv"),
      path: join(root, ".env"),
      environment: null,
      problems: [],
    });
    expect(parsed.values).toHaveLength(3);

    const both = await runCli(["pull", "--stdout", "--json"], { cwd: root, env: env() });
    expect(both.code).toBe(2);
  });

  it("reports a syntax problem offline", async () => {
    api = await mockApi({});
    const root = project("[env]\nGOOD = 1\nnot a line\n");
    const result = await runCli(["pull"], { cwd: root, env: env() });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^\.infraenv:3 /);
    expect(api.requests).toEqual([]);
  });

  it("names the declared environments when asked for another", async () => {
    api = await mockApi({});
    const root = project();
    const result = await runCli(["pull", "-e", "staging"], { cwd: root, env: env() });
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      ".infraenv has no [env.staging] section. Its environments: production.",
    );
  });

  it("warns when the output is not ignored by Git", async () => {
    api = await mockApi({ "GET /api/v1/whoami": whoamiRoute(), ...resolveRoute() });
    const root = project();
    writeFileSync(join(root, ".gitignore"), "");
    const result = await runCli(["pull"], { cwd: root, env: env() });
    expect(result.code).toBe(0);
    expect(result.err).toContain("warning: .env is not ignored by Git");
  });

  it("explains a key aimed at another organization", async () => {
    api = await mockApi({
      "GET /api/v1/whoami": whoamiRoute(ORG),
      [`POST /api/org/${OTHER_ORG}/env-files/resolve`]: () => ({
        status: 403,
        body: { error: "API key belongs to a different organization" },
      }),
    });
    const root = project(`[infrawrench]\norg = ${OTHER_ORG}\n\n${INFRAENV}`);
    const result = await runCli(["pull"], { cwd: root, env: env() });
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      `The API key belongs to organization ${ORG}, but the file's [infrawrench] org names ${OTHER_ORG}.`,
    );
  });

  it("explains a rejected key", async () => {
    api = await mockApi({
      "GET /api/v1/whoami": () => ({ status: 401, body: { error: "Unauthorized" } }),
    });
    const root = project();
    const result = await runCli(["pull"], { cwd: root, env: env() });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/did not accept the API key/);
  });

  it("says how to sign in when there is no key and no desktop CLI", async () => {
    const root = project();
    const result = await runCli(["pull"], { cwd: root, env: {} });
    expect(result.code).toBe(1);
    expect(result.err).toContain("Run `infraenv login`, or set INFRAWRENCH_API_KEY");
  });

  it("finds no file outside one and says so", async () => {
    api = await mockApi({});
    const root = gitInit();
    const result = await runCli(["pull"], { cwd: root, env: env() });
    expect(result.code).toBe(1);
    expect(result.err).toContain("No .infraenv here or in a parent directory");
  });
});
