import { execFile } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderDotenv } from "@infrawrench/client-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InfraenvError, config, load } from "../index";
import { generatedEnvironment, parseGeneratedDotenv } from "../resolve";
import {
  KEY,
  ORG,
  cleanupTempDirs,
  gitInit,
  isolateGit,
  mockApi,
  tempDir,
  whoamiRoute,
  type MockApi,
} from "./harness";

const PACKAGE = resolve(import.meta.dirname, "..", "..");

const INFRAENV = `[env]
NODE_ENV = development
DATABASE_URL = resource("neon/neon-branch", "storefront", "connectionString")
STRIPE_SECRET_KEY = secret("STRIPE_SECRET_KEY")

[env.production]
NODE_ENV = production
`;

// Every value the mock hands out; none may ever reach stderr or an error.
const SECRETS = ["postgres://fake-user:fake-pass@db.invalid/app", "sk_fake_value_for_tests"];
const VALUES = [
  { key: "DATABASE_URL", value: SECRETS[0]! },
  { key: "STRIPE_SECRET_KEY", value: SECRETS[1]! },
];

/** Keys the library reads from the environment, cleared around each test. */
const ENV_KEYS = [
  "INFRAWRENCH_API_KEY",
  "INFRAWRENCH_BASE_URL",
  "INFRAWRENCH_ORG_ID",
  "INFRAWRENCH_ORG",
  "INFRAENV_ENVIRONMENT",
  "INFRAENV_FILE",
  "XDG_CONFIG_HOME",
  "NODE_ENV",
  "DATABASE_URL",
  "STRIPE_SECRET_KEY",
];

let api: MockApi;
let saved: Record<string, string | undefined>;
let stderr: string;

const resolveRoute = (problems: unknown[] = []) => ({
  "GET /api/v1/whoami": whoamiRoute(),
  [`POST /api/org/${ORG}/env-files/resolve`]: (request: { body: unknown }) => {
    const environment = (request.body as { environment?: string }).environment ?? null;
    const values = [
      { key: "NODE_ENV", value: environment === "production" ? "production" : "development" },
      ...VALUES,
    ];
    return {
      status: 200,
      body: { environment, values, problems, dotenv: renderDotenv(values, { environment }) },
    };
  },
});

function project(): string {
  const root = gitInit();
  writeFileSync(join(root, ".infraenv"), INFRAENV);
  return root;
}

function expectNoValue(text: string): void {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expectNoValue(String(error));
    expectNoValue((error as Error).stack ?? "");
    return error as Error;
  }
  throw new Error("expected a rejection");
}

beforeAll(isolateGit);
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  // Never the developer's own `infraenv login`.
  process.env.XDG_CONFIG_HOME = tempDir("infraenv-xdg-");
  stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  expectNoValue(stderr);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await api?.close();
});
afterAll(cleanupTempDirs);

describe("config()", () => {
  it("resolves through the API with a key and assigns without overriding", async () => {
    api = await mockApi(resolveRoute());
    process.env.INFRAWRENCH_API_KEY = KEY;
    process.env.INFRAWRENCH_BASE_URL = api.url;
    process.env.NODE_ENV = "test";
    const result = await config({ cwd: project() });
    expect(result).toEqual({
      keys: ["DATABASE_URL", "STRIPE_SECRET_KEY"],
      skipped: ["NODE_ENV"],
      problems: [],
      environment: null,
      source: "api",
    });
    expect(process.env.NODE_ENV).toBe("test");
    expect(process.env.DATABASE_URL).toBe(SECRETS[0]);
    expect(api.requests.at(-1)!.authorization).toBe(`Bearer ${KEY}`);
  });

  it("overrides with override: true, and takes the apiKey, baseUrl and environment options", async () => {
    api = await mockApi(resolveRoute());
    process.env.NODE_ENV = "test";
    const result = await config({
      cwd: project(),
      apiKey: KEY,
      baseUrl: api.url,
      environment: "production",
      override: true,
    });
    expect(result.keys).toEqual(["NODE_ENV", "DATABASE_URL", "STRIPE_SECRET_KEY"]);
    expect(result.environment).toBe("production");
    expect(process.env.NODE_ENV).toBe("production");
  });

  it("reads INFRAENV_ENVIRONMENT by default", async () => {
    api = await mockApi(resolveRoute());
    process.env.INFRAENV_ENVIRONMENT = "production";
    const result = await load({ cwd: project(), apiKey: KEY, baseUrl: api.url });
    expect(result.environment).toBe("production");
    expect(result.values.NODE_ENV).toBe("production");
  });

  it("throws for required keys that are not set, naming the keys only", async () => {
    api = await mockApi(resolveRoute());
    const error = await rejection(
      config({
        cwd: project(),
        apiKey: KEY,
        baseUrl: api.url,
        required: ["DATABASE_URL", "REDIS_URL", "SENTRY_DSN"],
      }),
    );
    expect(error).toBeInstanceOf(InfraenvError);
    expect(error.message).toBe("Required variables are not set: REDIS_URL, SENTRY_DSN.");
    expect((error as InfraenvError).missing).toEqual(["REDIS_URL", "SENTRY_DSN"]);
  });

  it("writes problems to stderr once by default, throws on them with strict", async () => {
    const problems = [{ line: 3, key: "DATABASE_URL", message: "No resource by that name" }];
    api = await mockApi(resolveRoute(problems));
    const root = project();
    const result = await config({ cwd: root, apiKey: KEY, baseUrl: api.url });
    expect(result.problems).toEqual(problems);
    expect(stderr).toBe("infraenv: .infraenv:3 DATABASE_URL: No resource by that name\n");

    stderr = "";
    const quiet = await load({ cwd: root, apiKey: KEY, baseUrl: api.url, quiet: true });
    expect(quiet.problems).toHaveLength(1);
    expect(stderr).toBe("");

    const error = await rejection(
      config({ cwd: root, apiKey: KEY, baseUrl: api.url, strict: true }),
    );
    expect(error.message).toBe(
      "1 variable did not resolve: .infraenv:3 DATABASE_URL: No resource by that name",
    );
  });

  it("explains a rejected key without a value in sight", async () => {
    api = await mockApi({
      "GET /api/v1/whoami": () => ({ status: 401, body: { error: "Unauthorized" } }),
    });
    const error = await rejection(config({ cwd: project(), apiKey: KEY, baseUrl: api.url }));
    expect(error.message).toMatch(/did not accept the API key/);
  });
});

describe("source: auto without credentials", () => {
  it("reads the .env a pull generated", async () => {
    const root = project();
    writeFileSync(join(root, ".env"), renderDotenv(VALUES));
    const result = await config({ cwd: root });
    expect(result).toMatchObject({ source: "file", keys: ["DATABASE_URL", "STRIPE_SECRET_KEY"] });
    expect(process.env.STRIPE_SECRET_KEY).toBe(SECRETS[1]);
  });

  it("refuses a hand-written .env", async () => {
    const root = project();
    writeFileSync(join(root, ".env"), `DATABASE_URL=${SECRETS[0]}\n`);
    const error = await rejection(config({ cwd: root }));
    expect(error.message).toMatch(/^\.env was not written by `infraenv pull`/);
    expect(process.env.DATABASE_URL).toBeUndefined();
  });

  it("refuses a .env pulled for another environment", async () => {
    const root = project();
    writeFileSync(join(root, ".env"), renderDotenv(VALUES));
    const error = await rejection(config({ cwd: root, environment: "production" }));
    expect(error.message).toBe(
      ".env holds [env] alone, not environment production. Run `infraenv pull --env production`, or set INFRAWRENCH_API_KEY.",
    );
  });

  it("says how to get values when there is no key and no .env", async () => {
    const error = await rejection(config({ cwd: project() }));
    expect(error.message).toBe(
      "No Infrawrench API key and no .env to read: set INFRAWRENCH_API_KEY to an iwk_ key, run `infraenv login`, or run `infraenv pull` to write the .env.",
    );
  });

  it("uses the API for source: api and refuses it without a key", async () => {
    const error = await rejection(config({ cwd: project(), source: "api" }));
    expect(error.message).toMatch(/^No Infrawrench API key for source: "api"/);
  });

  it("reads the file for source: file even with a key", async () => {
    const root = project();
    writeFileSync(join(root, ".env"), renderDotenv(VALUES));
    const result = await load({
      cwd: root,
      apiKey: KEY,
      baseUrl: "http://127.0.0.1:9",
      source: "file",
    });
    expect(result.source).toBe("file");
    expect(result.values).toEqual({ DATABASE_URL: SECRETS[0], STRIPE_SECRET_KEY: SECRETS[1] });
  });

  it("reports a .infraenv that does not parse, by line", async () => {
    const root = gitInit();
    writeFileSync(join(root, ".infraenv"), "[env]\nnot a line\n");
    const error = await rejection(config({ cwd: root }));
    expect(error.message).toMatch(/^\.infraenv does not parse: \.infraenv:2 /);
  });
});

describe("the generated .env", () => {
  it("round-trips every value renderDotenv writes", () => {
    const values = [
      { key: "BARE", value: "abc-123_./:@%+,=~" },
      { key: "EMPTY", value: "" },
      { key: "SPACES", value: "two words  and more" },
      { key: "HASH", value: "a#b # not a comment" },
      { key: "SINGLE", value: 'it\'s "quoted"' },
      { key: "DOLLAR", value: "${HOME} $USER $${x}" },
      { key: "MULTILINE", value: "line one\nline two\r\n\tindented" },
      { key: "BACKSLASH", value: "C:\\path\\n not a newline \\\\" },
      { key: "PEM", value: "-----BEGIN KEY-----\nabc\n-----END KEY-----\n" },
      { key: "UNICODE", value: "héllo 世界 🚀" },
      { key: "CALL", value: 'resource("a", "b")' },
      { key: "EQUALS", value: "a=b=c" },
    ];
    for (const environment of [null, "production"]) {
      const text = renderDotenv(values, { environment, source: "apps/web/.infraenv" });
      expect(parseGeneratedDotenv(text)).toEqual(
        Object.fromEntries(values.map(({ key, value }) => [key, value])),
      );
      expect(generatedEnvironment(text)).toBe(environment);
    }
  });

  it("is only read with the generated header", () => {
    expect(parseGeneratedDotenv("A=1\n")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The built package, in child processes: the CJS entries, configSync and its
// worker, and `@infrawrench/infraenv/config`. Children, because configSync
// blocks its process and the mock server lives in this one.
// ---------------------------------------------------------------------------

/** A project that installed the package, so its exports resolve by name. */
function consumer(): string {
  const root = project();
  mkdirSync(join(root, "node_modules", "@infrawrench"), { recursive: true });
  symlinkSync(PACKAGE, join(root, "node_modules", "@infrawrench", "infraenv"), "dir");
  return root;
}

function child(
  cwd: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      args,
      {
        cwd,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: tempDir("infraenv-home-"),
          XDG_CONFIG_HOME: tempDir("infraenv-xdg-"),
          GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL ?? "",
          GIT_CONFIG_NOSYSTEM: "1",
          ...env,
        },
        encoding: "utf8",
      },
      (error, stdout, stderr) =>
        done({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        }),
    );
  });
}

const PRINT = `console.log(JSON.stringify({ db: process.env.DATABASE_URL, node: process.env.NODE_ENV }))`;

describe("the built package", () => {
  it("@infrawrench/infraenv/config sets the variables before the next import", async () => {
    api = await mockApi(resolveRoute());
    const root = consumer();
    writeFileSync(join(root, "app.mjs"), `${PRINT};\n`);
    writeFileSync(
      join(root, "main.mjs"),
      `import "@infrawrench/infraenv/config";\nawait import("./app.mjs");\n`,
    );
    const env = { INFRAWRENCH_API_KEY: KEY, INFRAWRENCH_BASE_URL: api.url };
    const run = await child(root, ["main.mjs"], env);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual({ db: SECRETS[0], node: "development" });

    const preloaded = await child(root, ["--import", "@infrawrench/infraenv/config", "app.mjs"], {
      ...env,
      INFRAENV_ENVIRONMENT: "production",
    });
    expect(JSON.parse(preloaded.stdout)).toEqual({ db: SECRETS[0], node: "production" });
  });

  it("require() of both entries works, /config through configSync", async () => {
    api = await mockApi(resolveRoute());
    const root = consumer();
    writeFileSync(
      join(root, "main.cjs"),
      `const lib = require("@infrawrench/infraenv");
if (typeof lib.config !== "function" || typeof lib.configSync !== "function") throw new Error("exports");
require("@infrawrench/infraenv/config");
${PRINT};\n`,
    );
    const run = await child(root, ["main.cjs"], {
      INFRAWRENCH_API_KEY: KEY,
      INFRAWRENCH_BASE_URL: api.url,
      NODE_ENV: "test",
    });
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual({ db: SECRETS[0], node: "test" });
  });

  it("configSync passes options, returns keys only, and fails without a value in sight", async () => {
    api = await mockApi(resolveRoute());
    const root = consumer();
    writeFileSync(
      join(root, "sync.cjs"),
      `const { configSync } = require("@infrawrench/infraenv");
const options = JSON.parse(process.argv[2]);
try {
  const result = configSync(options);
  console.log(JSON.stringify({ result, db: process.env.DATABASE_URL }));
} catch (error) {
  console.log(JSON.stringify({ name: error.name, message: error.message, missing: error.missing }));
}\n`,
    );
    const options = { apiKey: KEY, baseUrl: api.url, environment: "production", override: true };
    const ok = await child(root, ["sync.cjs", JSON.stringify(options)], {});
    expect(ok.stderr).toBe("");
    expect(JSON.parse(ok.stdout)).toEqual({
      result: {
        keys: ["NODE_ENV", "DATABASE_URL", "STRIPE_SECRET_KEY"],
        skipped: [],
        problems: [],
        environment: "production",
        source: "api",
      },
      db: SECRETS[0],
    });
    // The key went over stdin, not the worker's command line.
    expect(api.requests.at(-1)!.authorization).toBe(`Bearer ${KEY}`);

    const required = await child(
      root,
      ["sync.cjs", JSON.stringify({ ...options, required: ["MISSING_ONE"] })],
      {},
    );
    expect(JSON.parse(required.stdout)).toEqual({
      name: "InfraenvError",
      message: "Required variable is not set: MISSING_ONE.",
      missing: ["MISSING_ONE"],
    });

    const refused = await child(root, ["sync.cjs", JSON.stringify({})], {});
    const failure = JSON.parse(refused.stdout) as { name: string; message: string };
    expect(failure.name).toBe("InfraenvError");
    expect(failure.message).toMatch(/^No Infrawrench API key and no \.env to read/);
    for (const run of [required, refused]) {
      expectNoValue(run.stdout);
      expectNoValue(run.stderr);
    }
  });

  it("is harmless next to a kill-emudhra the program imported itself", async () => {
    api = await mockApi(resolveRoute());
    const root = consumer();
    const ownCopy = resolve(PACKAGE, "node_modules", "kill-emudhra");
    symlinkSync(ownCopy, join(root, "node_modules", "kill-emudhra"), "dir");
    writeFileSync(
      join(root, "main.mjs"),
      `import "kill-emudhra";
import tls from "node:tls";
const before = tls.checkServerIdentity;
const { config } = await import("@infrawrench/infraenv");
await config();
if (tls.checkServerIdentity !== before) throw new Error("wrapped twice");
${PRINT};\n`,
    );
    const run = await child(root, ["main.mjs"], {
      INFRAWRENCH_API_KEY: KEY,
      INFRAWRENCH_BASE_URL: api.url,
    });
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout).db).toBe(SECRETS[0]);
  });
});
