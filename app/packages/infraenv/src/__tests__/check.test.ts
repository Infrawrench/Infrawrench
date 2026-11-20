import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  KEY,
  ORG,
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
CACHE_URL = resource("upstash:acct:redis-1", "restUrl")
STRIPE_SECRET_KEY = secret("STRIPE_SECRET_KEY")

[vars.production]
stage = prod

[env.production]
NODE_ENV = production
DATABASE_URL = resource("neon/neon-branch", "storefront / \${stage}", "connectionString")
`;

let api: MockApi;

beforeAll(isolateGit);
afterEach(async () => api?.close());
afterAll(cleanupTempDirs);

const described = {
  problems: [{ line: 7, key: "CACHE_URL", message: "Resource not found" }],
  environments: ["production"],
  resources: [
    {
      ref: "name:neon/neon-branch\u0000storefront / dev\u0000connectionString",
      resourceId: "neon:acct:br-dev",
      output: "connectionString",
      found: true,
      displayName: "storefront / dev",
      pluginName: "Neon",
      resourceTypeName: "Branch",
      accountName: "Main",
      outputLabel: "Connection string",
      outputKnown: true,
      sensitive: true,
    },
    {
      ref: "name:neon/neon-branch\u0000storefront / prod\u0000connectionString",
      output: "connectionString",
      found: false,
      matches: 2,
      outputKnown: true,
      sensitive: true,
    },
    {
      ref: "id:upstash:acct:redis-1\u0000restUrl",
      resourceId: "upstash:acct:redis-1",
      output: "restUrl",
      found: false,
      outputKnown: false,
      sensitive: false,
    },
  ],
  secrets: [{ name: "STRIPE_SECRET_KEY", found: true, hasValue: false }],
};

describe("infraenv check", () => {
  it("marks each reference per section and exits 1 on problems", async () => {
    api = await mockApi({
      "GET /api/v1/whoami": whoamiRoute(),
      [`POST /api/org/${ORG}/env-files/describe`]: () => ({ status: 200, body: described }),
    });
    const root = gitInit();
    writeFileSync(join(root, ".infraenv"), INFRAENV);
    const result = await runCli(["check"], {
      cwd: root,
      env: { INFRAWRENCH_API_KEY: KEY, INFRAWRENCH_BASE_URL: api.url },
    });
    expect(result.code).toBe(1);
    const lines = result.out.split("\n");
    expect(lines[0]).toBe(`.infraenv · organization ${ORG}`);
    expect(lines[1]).toBe("environments: production");
    const row = (key: string, section: string) => {
      const start = lines.indexOf(section);
      return lines.slice(start).find((line) => line.trimStart().startsWith(`${key} `));
    };
    expect(row("NODE_ENV", "[env]")).toMatch(/literal$/);
    expect(row("DATABASE_URL", "[env]")).toMatch(
      /storefront \/ dev · Neon Branch · Main · Connection string {2}✓$/,
    );
    expect(row("DATABASE_URL", "[env.production]")).toBe(
      '  DATABASE_URL       neon/neon-branch "storefront / prod" · connectionString  ✗ Ambiguous: 2 resources match',
    );
    expect(row("CACHE_URL", "[env]")).toBe(
      "  CACHE_URL          upstash:acct:redis-1 · restUrl  ✗ Resource not found",
    );
    expect(row("STRIPE_SECRET_KEY", "[env]")).toMatch(
      /STRIPE_SECRET_KEY · Organization secret {2}! The organization secret STRIPE_SECRET_KEY has no value yet$/,
    );
    expect(result.out).toContain("1 problem\n  .infraenv:7 CACHE_URL: Resource not found");

    const request = api.requests.find((r) => r.path.endsWith("/describe"))!;
    expect(request.body).toEqual({ source: INFRAENV });
  });

  it("sends --var and prints the response with --json", async () => {
    api = await mockApi({
      [`POST /api/org/${ORG}/env-files/describe`]: () => ({
        status: 200,
        body: { ...described, problems: [] },
      }),
    });
    const root = gitInit();
    writeFileSync(join(root, ".infraenv"), INFRAENV);
    const result = await runCli(["check", "--json", "--var", "stage=qa", "--org", ORG], {
      cwd: root,
      env: { INFRAWRENCH_API_KEY: KEY, INFRAWRENCH_BASE_URL: api.url },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ org: ORG, environments: ["production"] });
    expect(api.requests[0]!.body).toEqual({ source: INFRAENV, vars: { stage: "qa" } });
  });
});
