import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GENERATED_DOTENV_MARKER,
  INFRAENV_HOOKS,
  infraenvHookBlock,
  infraenvReferenceKey,
} from "@infrawrench/client-core";

// `env pull|check|init|hooks` on effect/cli, in a temporary Git repository
// with the cloud faked. Nothing reaches a network or the real checkout.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getVersion: () => "9.9.9" },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("../cloud-tokens", () => ({
  getAccessToken: vi.fn(async () => "tok"),
  forceRefreshAccessToken: vi.fn(async () => null),
  fetchCloudOrgs: vi.fn(async () => [
    { id: "org_1", displayName: "Acme", role: "admin" },
    { id: "org_2", displayName: "Beta", role: "admin" },
  ]),
  getAuthStatus: vi.fn(async () => ({ authenticated: true, email: "ada@example.com" })),
  clearStoredTokens: vi.fn(),
  createPkceChallenge: vi.fn(),
  buildAuthorizeUrl: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
  setTokenStoreReadOnly: vi.fn(),
}));

import { run, serveRoutes, useCliCapture } from "./cli-harness";

const out = useCliCapture();

let dir = "";
let cwd = "";

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "iw-env-")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  cwd = dir;
  vi.spyOn(process, "cwd").mockImplementation(() => cwd);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const INFRAENV = `[infrawrench]
org = org_1

[env]
NODE_ENV = development
DATABASE_URL = resource("res_db", "connectionString")
STRIPE_KEY = secret("STRIPE_KEY")

[env.production]
NODE_ENV = production
`;

const DOTENV = `${GENERATED_DOTENV_MARKER}
# Source: .infraenv.

NODE_ENV=development
DATABASE_URL=postgres://u:p@h/db
`;

const RESOLVED = {
  environment: null,
  values: [
    { key: "NODE_ENV", value: "development" },
    { key: "DATABASE_URL", value: "postgres://u:p@h/db" },
  ],
  problems: [],
  dotenv: DOTENV,
};

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

/** Every request's org id and JSON body, in order. */
const sent = () =>
  vi.mocked(fetch).mock.calls.map(([url, init]) => ({
    org: new URL(String(url)).pathname.split("/")[3],
    body: JSON.parse(String(init?.body)) as Record<string, unknown>,
  }));

const scrub = (text: string) => text.replaceAll(dir, "<dir>");

describe("env", () => {
  it("lists its verbs when run bare", async () => {
    expect(await run("env")).toBe(0);
    for (const verb of ["pull", "check", "init", "hooks"]) expect(out.stdout).toContain(verb);
  });
});

describe("env pull", () => {
  it("writes .env with mode 0600 and warns that it is not ignored", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    serveRoutes(out, { "POST /env-files/resolve": RESOLVED });
    expect(await run("env", "pull")).toBe(0);
    const target = join(dir, ".env");
    expect(readFileSync(target, "utf8")).toBe(DOTENV);
    if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(out.stdout).toBe("Wrote .env (2 variables)\n");
    expect(out.stderr).toBe(
      "warning: .env is not ignored by Git, and it holds secret values. Add it to .gitignore.\n",
    );
    expect(sent()).toEqual([{ org: "org_1", body: { source: INFRAENV, sourceName: ".infraenv" } }]);
    // Nothing left behind by the atomic write.
    expect(existsSync(`${target}.${process.pid}.tmp`)).toBe(false);
  });

  it("says nothing about Git once .env is ignored", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    write(join(dir, ".gitignore"), ".env\n");
    serveRoutes(out, { "POST /env-files/resolve": RESOLVED });
    expect(await run("env", "pull")).toBe(0);
    expect(out.stderr).toBe("");
  });

  it("refuses to replace a hand-written .env without --force", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    write(join(dir, ".env"), "API_KEY=mine\n");
    serveRoutes(out, { "POST /env-files/resolve": RESOLVED });
    expect(await run("env", "pull")).toBe(1);
    expect(out.stderr).toContain(".env exists and looks hand-written");
    expect(out.stderr).toContain("pass --force to replace it");
    expect(out.requests).toEqual([]);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("API_KEY=mine\n");

    out.stderr = "";
    expect(await run("env", "pull", "--force")).toBe(0);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(DOTENV);
  });

  it("replaces a .env it generated before", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    write(join(dir, ".env"), `${GENERATED_DOTENV_MARKER}\nOLD=1\n`);
    serveRoutes(out, { "POST /env-files/resolve": RESOLVED });
    expect(await run("env", "pull")).toBe(0);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(DOTENV);
  });

  it("resolves one environment with --env and refuses one the file does not declare", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    serveRoutes(out, {
      "POST /env-files/resolve": { ...RESOLVED, environment: "production" },
    });
    expect(await run("env", "pull", "--env", "production")).toBe(0);
    expect(out.stdout).toBe("Wrote .env (2 variables, environment production)\n");
    expect(sent()[0]!.body).toEqual({
      source: INFRAENV,
      environment: "production",
      sourceName: ".infraenv",
    });

    out.stdout = "";
    out.stderr = "";
    expect(await run("env", "pull", "--env", "staging")).toBe(1);
    expect(out.stderr).toContain(
      ".infraenv has no [env.staging] section. Its environments: production.",
    );
  });

  it("prints the .env with --stdout and writes nothing", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    serveRoutes(out, { "POST /env-files/resolve": RESOLVED });
    expect(await run("env", "pull", "--stdout")).toBe(0);
    expect(out.stdout).toBe(DOTENV);
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it("writes to --out, relative to the working directory", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    serveRoutes(out, { "POST /env-files/resolve": RESOLVED });
    expect(await run("env", "pull", "--out", "build/app.env")).toBe(0);
    expect(readFileSync(join(dir, "build/app.env"), "utf8")).toBe(DOTENV);
    expect(out.stdout).toBe("Wrote build/app.env (2 variables)\n");
    expect(sent()[0]!.body.sourceName).toBe("../.infraenv");
  });

  it("finds the file from a subdirectory and honours its output setting", async () => {
    write(
      join(dir, ".infraenv"),
      INFRAENV.replace("org = org_1", "org = org_1\noutput = config/app.env"),
    );
    mkdirSync(join(dir, "src/deep"), { recursive: true });
    cwd = join(dir, "src/deep");
    serveRoutes(out, { "POST /env-files/resolve": RESOLVED });
    expect(await run("env", "pull")).toBe(0);
    expect(readFileSync(join(dir, "config/app.env"), "utf8")).toBe(DOTENV);
    expect(out.stdout).toBe("Wrote ../../config/app.env (2 variables)\n");
    expect(sent()[0]!.body.sourceName).toBe("../.infraenv");
  });

  it("does not look above the repository root", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    mkdirSync(join(dir, "nested"));
    execFileSync("git", ["init", "-q"], { cwd: join(dir, "nested") });
    cwd = join(dir, "nested");
    serveRoutes(out, {});
    expect(await run("env", "pull")).toBe(1);
    expect(out.stderr).toContain("No .infraenv here or in a parent directory");
  });

  it("uses the file's org setting, and --org over it", async () => {
    write(join(dir, ".infraenv"), INFRAENV.replace("org = org_1", "org = org_2"));
    serveRoutes(out, { "POST /env-files/resolve": RESOLVED });
    expect(await run("env", "pull")).toBe(0);
    expect(await run("env", "pull", "--org", "Acme")).toBe(0);
    expect(sent().map((request) => request.org)).toEqual(["org_2", "org_1"]);
  });

  it("asks for an org when neither the line nor the file names one", async () => {
    write(join(dir, ".infraenv"), INFRAENV.replace("[infrawrench]\norg = org_1\n\n", ""));
    serveRoutes(out, { "POST /env-files/resolve": RESOLVED });
    expect(await run("env", "pull")).toBe(1);
    expect(out.stderr).toContain("Multiple organizations: pass --org <id|name>");
    expect(out.requests).toEqual([]);
  });

  it("writes what resolved, prints each problem and exits 1", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    serveRoutes(out, {
      "POST /env-files/resolve": {
        ...RESOLVED,
        problems: [
          { line: 7, key: "STRIPE_KEY", message: 'No organization secret named "STRIPE_KEY"' },
        ],
      },
    });
    expect(await run("env", "pull")).toBe(1);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(DOTENV);
    expect(out.stdout).toBe("Wrote .env (2 variables)\n");
    expect(out.stderr).toContain(
      '.infraenv:7 STRIPE_KEY: No organization secret named "STRIPE_KEY"\n',
    );
    expect(out.stderr).toContain("1 variable did not resolve and was left out.");
  });

  it("reports a syntax error without calling the cloud", async () => {
    write(join(dir, ".infraenv"), '[env]\nBROKEN = resource("x")\n');
    serveRoutes(out, {});
    expect(await run("env", "pull")).toBe(1);
    expect(out.stderr).toBe(
      '.infraenv:2 BROKEN: resource() takes resource("<id>", "<output>") or resource("<plugin>/<type>", "<name>", "<output>")\n',
    );
    expect(out.requests).toEqual([]);
  });

  it("prints the server's body under --json", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    serveRoutes(out, { "POST /env-files/resolve": RESOLVED });
    expect(await run("env", "pull", "--json")).toBe(0);
    expect(JSON.parse(scrub(out.stdout))).toEqual({
      org: "org_1",
      file: "<dir>/.infraenv",
      path: "<dir>/.env",
      ...RESOLVED,
    });
  });

  it("prints nothing with --quiet", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    serveRoutes(out, { "POST /env-files/resolve": RESOLVED });
    expect(await run("env", "pull", "--quiet")).toBe(0);
    expect(out.stdout).toBe("");
    expect(out.stderr).toBe("");
    expect(existsSync(join(dir, ".env"))).toBe(true);
  });

  it("sends each --var as vars, a later one winning", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    serveRoutes(out, { "POST /env-files/resolve": RESOLVED });
    expect(
      await run("env", "pull", "--var", "stage=dev", "--var", "region=eu=1", "--var", "stage=prod"),
    ).toBe(0);
    expect(sent()[0]!.body).toEqual({
      source: INFRAENV,
      vars: { stage: "prod", region: "eu=1" },
      sourceName: ".infraenv",
    });
  });

  it("refuses a --var without a name=value or with a name that is not one", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    serveRoutes(out, {});
    expect(await run("env", "pull", "--var", "stage")).toBe(2);
    expect(out.stderr).toContain("--var takes name=value");
    expect(out.stderr).toContain('got "stage"');
    out.stderr = "";
    expect(await run("env", "pull", "--var", "1st=x")).toBe(2);
    expect(out.stderr).toContain('got "1st=x"');
    out.stderr = "";
    expect(await run("env", "check", "--var", "a-b=x")).toBe(2);
    expect(out.stderr).toContain('got "a-b=x"');
    expect(out.requests).toEqual([]);
  });

  it("refuses --local and contradictory output flags", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    serveRoutes(out, {});
    expect(await run("env", "pull", "--local")).toBe(2);
    expect(out.stderr).toContain("Env files resolve through Infrawrench Cloud");
    out.stderr = "";
    expect(await run("env", "pull", "--stdout", "--out", "x")).toBe(2);
    expect(out.stderr).toContain("--stdout and --out are mutually exclusive");
  });
});

const DESCRIBED = {
  problems: [],
  environments: ["production"],
  resources: [
    {
      ref: infraenvReferenceKey({
        kind: "resource",
        resourceId: "res_db",
        output: "connectionString",
      }),
      resourceId: "res_db",
      output: "connectionString",
      found: true,
      displayName: "main",
      pluginId: "neon",
      pluginName: "Neon",
      resourceTypeId: "neon_branch",
      resourceTypeName: "Branch",
      accountId: "acc_1",
      accountName: "acme-neon",
      outputLabel: "Connection string",
      outputKnown: true,
      sensitive: true,
    },
  ],
  secrets: [{ name: "STRIPE_KEY", found: true, hasValue: true }],
};

describe("env check", () => {
  it("names each reference and exits 0 when nothing is broken", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    serveRoutes(out, { "POST /env-files/describe": DESCRIBED });
    expect(await run("env", "check")).toBe(0);
    expect(out.stdout).toBe(
      [
        ".infraenv · Acme",
        "environments: production",
        "",
        "[env]",
        "  NODE_ENV      literal",
        "  DATABASE_URL  main · Neon Branch · acme-neon · Connection string  ✓",
        "  STRIPE_KEY    secret STRIPE_KEY  ✓",
        "",
        "[env.production]",
        "  NODE_ENV      literal",
        "",
        "No problems.",
        "",
      ].join("\n"),
    );
    expect(sent()).toEqual([{ org: "org_1", body: { source: INFRAENV } }]);
  });

  it("marks broken references, lists the problems and exits 1", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    serveRoutes(out, {
      "POST /env-files/describe": {
        ...DESCRIBED,
        problems: [
          { line: 6, key: "DATABASE_URL", message: "Resource res_db not found" },
          { line: 7, key: "STRIPE_KEY", message: "Secret STRIPE_KEY has no value" },
        ],
        resources: [{ ...DESCRIBED.resources[0], found: false }],
        secrets: [{ name: "STRIPE_KEY", found: true, hasValue: false }],
      },
    });
    expect(await run("env", "check")).toBe(1);
    expect(out.stdout).toContain("DATABASE_URL  res_db · connectionString  ✗ resource not found");
    expect(out.stdout).toContain("STRIPE_KEY    secret STRIPE_KEY  ! no value set");
    expect(out.stdout).toContain("2 problems\n");
    expect(out.stdout).toContain("  .infraenv:6 DATABASE_URL: Resource res_db not found\n");
  });

  it("shows what a by-name reference matched, or why not, per environment", async () => {
    const source = [
      "[vars]",
      "stage = dev",
      "",
      "[env]",
      'DATABASE_URL = resource("neon/neon-branch", "storefront / ${stage}", "connectionString")',
      'CACHE_URL = resource("upstash/redis@prod-acct", "cache", "restUrl")',
      'MISSING = secret("${nope}_KEY")',
      "",
      "[vars.production]",
      "stage = prod",
      "",
      "[env.production]",
      'DATABASE_URL = resource("neon/neon-branch", "storefront / ${stage}", "connectionString")',
      "",
    ].join("\n");
    write(join(dir, ".infraenv"), source);
    const named = (name: string, output: string, account?: string) => {
      const match = {
        pluginId: name.startsWith("storefront") ? "neon" : "upstash",
        resourceTypeId: name.startsWith("storefront") ? "neon-branch" : "redis",
        name,
        ...(account ? { account } : {}),
      };
      return { ref: infraenvReferenceKey({ kind: "named-resource", match, output }), match };
    };
    serveRoutes(out, {
      "POST /env-files/describe": {
        problems: [
          {
            line: 5,
            key: "DATABASE_URL",
            message: '2 resources match neon/neon-branch "storefront / dev"',
          },
        ],
        environments: ["production"],
        resources: [
          {
            ...named("storefront / dev", "connectionString"),
            matches: 2,
            output: "connectionString",
            found: false,
            outputKnown: false,
            sensitive: true,
          },
          {
            ...named("cache", "restUrl", "prod-acct"),
            matches: 1,
            resourceId: "res_cache",
            output: "restUrl",
            found: true,
            displayName: "cache",
            pluginName: "Upstash",
            resourceTypeName: "Redis",
            accountName: "prod-acct",
            outputLabel: "REST URL",
            outputKnown: true,
            sensitive: true,
          },
          {
            ...named("storefront / prod", "connectionString"),
            matches: 1,
            resourceId: "res_prod",
            output: "connectionString",
            found: true,
            displayName: "storefront / prod",
            pluginName: "Neon",
            resourceTypeName: "Branch",
            accountName: "acme-neon",
            outputLabel: "Connection string",
            outputKnown: true,
            sensitive: true,
          },
        ],
        secrets: [],
      },
    });
    expect(await run("env", "check", "--org", "org_1")).toBe(1);
    expect(out.stdout).toBe(
      [
        ".infraenv · Acme",
        "environments: production",
        "",
        "[env]",
        '  DATABASE_URL  neon/neon-branch "storefront / dev" · connectionString  ✗ ambiguous: 2 resources match',
        "  CACHE_URL     cache · Upstash Redis · prod-acct · REST URL  ✓",
        '  MISSING       secret("${nope}_KEY")  ✗ no value for ${nope}',
        "",
        "[env.production]",
        "  DATABASE_URL  storefront / prod · Neon Branch · acme-neon · Connection string  ✓",
        "",
        "3 problems",
        '  .infraenv:5 DATABASE_URL: 2 resources match neon/neon-branch "storefront / dev"',
        "  .infraenv:7 MISSING: No value for ${nope}: set it in [vars]",
        "  .infraenv:7 MISSING: No value for ${nope}: set it in [vars] (environment production)",
        "",
      ].join("\n"),
    );
    expect(sent()).toEqual([{ org: "org_1", body: { source } }]);
  });

  it("names a by-name reference that matched nothing, and sends --var", async () => {
    const source =
      '[env]\nDB = resource("neon/neon-branch", "app / ${stage}", "connectionString")\n';
    write(join(dir, ".infraenv"), source);
    const match = { pluginId: "neon", resourceTypeId: "neon-branch", name: "app / qa" };
    serveRoutes(out, {
      "POST /env-files/describe": {
        problems: [{ line: 2, key: "DB", message: 'No neon/neon-branch named "app / qa"' }],
        environments: [],
        resources: [
          {
            ref: infraenvReferenceKey({
              kind: "named-resource",
              match,
              output: "connectionString",
            }),
            match,
            matches: 0,
            output: "connectionString",
            found: false,
            outputKnown: false,
            sensitive: true,
          },
        ],
        secrets: [],
      },
    });
    expect(await run("env", "check", "--org", "org_1", "--var", "stage=qa")).toBe(1);
    expect(out.stdout).toContain(
      '  DB  neon/neon-branch "app / qa" · connectionString  ✗ no resource by that name\n',
    );
    expect(out.stdout).toContain("1 problem\n");
    expect(sent()).toEqual([{ org: "org_1", body: { source, vars: { stage: "qa" } } }]);
  });

  it("prints the body under --json", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    serveRoutes(out, { "POST /env-files/describe": DESCRIBED });
    expect(await run("env", "check", "--json")).toBe(0);
    expect(JSON.parse(scrub(out.stdout))).toEqual({
      org: "org_1",
      file: "<dir>/.infraenv",
      ...DESCRIBED,
    });
  });
});

describe("env init", () => {
  it("creates a .infraenv from a .env's keys, never its values, and ignores .env", async () => {
    write(join(dir, ".env"), '# keep\nAPI_KEY=hunter2\nexport DB_URL="postgres://x"\n');
    write(join(dir, ".gitignore"), "node_modules");
    serveRoutes(out, {});
    expect(await run("env", "init", "--from", ".env", "--org", "Beta")).toBe(0);
    const created = readFileSync(join(dir, ".infraenv"), "utf8");
    // Portable: no org pinned, so it resolves in whichever organization pulls it.
    expect(created).not.toContain("[infrawrench]");
    expect(created).not.toContain("org =");
    expect(created).toContain('[env]\nAPI_KEY = secret("API_KEY")\nDB_URL = secret("DB_URL")\n');
    expect(created).not.toContain("hunter2");
    expect(created).not.toContain("postgres");
    expect(created).not.toContain("keep");
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(
      "node_modules\n# Generated from .infraenv by `infrawrench env pull`; holds secret values\n.env\n",
    );
    expect(out.stdout).toContain("Created .infraenv with 2 variables from .env\n");
    expect(out.stdout).toContain("add the values as organization secrets");
    expect(out.stdout).toContain("Added .env to .gitignore\n");
    expect(out.requests).toEqual([]);
  });

  it("installs the hooks by default and says how to remove them", async () => {
    serveRoutes(out, {});
    expect(await run("env", "init")).toBe(0);
    for (const hook of INFRAENV_HOOKS) {
      expect(readFileSync(join(dir, ".git/hooks", hook), "utf8")).toBe(
        `#!/bin/sh\n${infraenvHookBlock(hook, { file: ".infraenv", output: ".env" })}\n`,
      );
    }
    expect(out.stdout).toBe(
      [
        "Created .infraenv",
        "Added .env to .gitignore",
        "Installed Git hooks that pull .env when a commit changes it; `infrawrench env hooks uninstall` removes them.",
        "Commit it, then run `infrawrench env pull` to write .env.",
        "",
      ].join("\n"),
    );
    expect(out.requests).toEqual([]);
  });

  it("skips the hooks with --no-hooks, and leaves .gitignore alone when .env is ignored", async () => {
    write(join(dir, ".gitignore"), ".env*\n");
    serveRoutes(out, {});
    expect(await run("env", "init", "--no-hooks", "--json")).toBe(0);
    expect(JSON.parse(scrub(out.stdout))).toEqual({
      path: "<dir>/.infraenv",
      variables: [],
      gitignore: "ignored",
      hooks: null,
    });
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".env*\n");
    for (const hook of INFRAENV_HOOKS)
      expect(existsSync(join(dir, ".git/hooks", hook))).toBe(false);
  });

  it("anchors the pattern and the hook paths for a .infraenv below the repository root", async () => {
    mkdirSync(join(dir, "apps/web"), { recursive: true });
    cwd = join(dir, "apps/web");
    serveRoutes(out, {});
    expect(await run("env", "init", "--json")).toBe(0);
    expect(existsSync(join(dir, "apps/web/.infraenv"))).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("\n/apps/web/.env\n");
    const result = JSON.parse(scrub(out.stdout)) as {
      hooks: Array<{ hook: string; change: string }>;
    };
    expect(result.hooks.map((row) => [row.hook, row.change])).toEqual(
      INFRAENV_HOOKS.map((hook) => [hook, "created"]),
    );
    expect(readFileSync(join(dir, ".git/hooks/post-commit"), "utf8")).toContain(
      infraenvHookBlock("post-commit", { file: "apps/web/.infraenv", output: "apps/web/.env" }),
    );
  });

  it("leaves hooks that already pull another .infraenv alone", async () => {
    mkdirSync(join(dir, "apps/web"), { recursive: true });
    mkdirSync(join(dir, "apps/api"), { recursive: true });
    serveRoutes(out, {});
    cwd = join(dir, "apps/web");
    expect(await run("env", "init")).toBe(0);
    const before = readFileSync(join(dir, ".git/hooks/post-merge"), "utf8");
    out.stdout = "";
    cwd = join(dir, "apps/api");
    expect(await run("env", "init")).toBe(0);
    expect(out.stdout).toContain(
      "Left the Git hooks alone: they pull another .infraenv. `infrawrench env hooks install -f .infraenv` points them here.\n",
    );
    expect(readFileSync(join(dir, ".git/hooks/post-merge"), "utf8")).toBe(before);
  });

  it("refuses to replace an existing file", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    serveRoutes(out, {});
    expect(await run("env", "init", "--org", "org_1")).toBe(1);
    expect(out.stderr).toContain(".infraenv already exists");
    expect(readFileSync(join(dir, ".infraenv"), "utf8")).toBe(INFRAENV);
  });
});

describe("env hooks", () => {
  const hook = (name: string) => join(dir, ".git/hooks", name);

  it("installs, reports and uninstalls its own hooks", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    expect(await run("env", "hooks", "install")).toBe(0);
    expect(out.stdout).toBe(
      [
        "post-checkout  installed",
        "post-merge     installed",
        "post-rewrite   installed",
        "post-commit    installed",
        ".infraenv is pulled into .env when a checkout, merge, rebase or commit changes it.",
        "",
      ].join("\n"),
    );
    for (const name of INFRAENV_HOOKS) {
      expect(readFileSync(hook(name), "utf8")).toBe(
        `#!/bin/sh\n${infraenvHookBlock(name, { file: ".infraenv", output: ".env" })}\n`,
      );
      if (process.platform !== "win32") expect(statSync(hook(name)).mode & 0o111).toBe(0o111);
    }

    out.stdout = "";
    expect(await run("env", "hooks", "install")).toBe(0);
    expect(out.stdout).toContain("post-merge     already installed\n");

    out.stdout = "";
    expect(await run("env", "hooks")).toBe(0);
    expect(out.stdout).toContain("post-checkout  installed\n");
    expect(out.stdout).toContain("post-commit    installed\n");

    out.stdout = "";
    expect(await run("env", "hooks", "uninstall")).toBe(0);
    expect(out.stdout).toContain("post-checkout  removed\n");
    expect(existsSync(hook("post-checkout"))).toBe(false);

    out.stdout = "";
    expect(await run("env", "hooks", "status", "--json")).toBe(0);
    const status = JSON.parse(scrub(out.stdout)) as {
      hooks: Array<{ hook: string; state: string }>;
    };
    expect(status.hooks.map((h) => [h.hook, h.state])).toEqual([
      ["post-checkout", "absent"],
      ["post-merge", "absent"],
      ["post-rewrite", "absent"],
      ["post-commit", "absent"],
    ]);
  });

  it("appends to a hook someone else wrote and restores it on uninstall", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    const foreign = "#!/bin/sh\necho 'lint on merge'\n";
    write(hook("post-merge"), foreign);
    chmodSync(hook("post-merge"), 0o755);
    expect(await run("env", "hooks", "install")).toBe(0);
    expect(out.stdout).toContain("post-merge     added to the existing hook\n");
    const text = readFileSync(hook("post-merge"), "utf8");
    expect(text.startsWith(`${foreign}\n# >>> infrawrench env >>>\n`)).toBe(true);

    out.stdout = "";
    expect(await run("env", "hooks", "status")).toBe(0);
    expect(out.stdout).toContain("post-merge     installed (inside an existing hook)\n");

    out.stdout = "";
    expect(await run("env", "hooks", "uninstall")).toBe(0);
    expect(out.stdout).toContain("post-merge     removed from the existing hook\n");
    expect(readFileSync(hook("post-merge"), "utf8")).toBe(foreign);
  });

  it("leaves a hook in another language alone and exits 1", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    const foreign = "#!/usr/bin/env node\nconsole.log('hi')\n";
    write(hook("post-merge"), foreign);
    expect(await run("env", "hooks", "install")).toBe(1);
    expect(out.stdout).toContain("post-merge     skipped: it runs under /usr/bin/env node");
    expect(readFileSync(hook("post-merge"), "utf8")).toBe(foreign);
    expect(existsSync(hook("post-checkout"))).toBe(true);
  });

  it("installs where core.hooksPath points, with the file's paths from the root", async () => {
    write(
      join(dir, "apps/web/.infraenv"),
      INFRAENV.replace("org = org_1", "org = org_1\noutput = config/app.env"),
    );
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: dir });
    cwd = join(dir, "apps/web");
    expect(await run("env", "hooks", "install", "--json")).toBe(0);
    const result = JSON.parse(scrub(out.stdout)) as Record<string, unknown>;
    expect(result.infraenv).toBe("apps/web/.infraenv");
    expect(result.output).toBe("apps/web/config/app.env");
    const text = readFileSync(join(dir, ".githooks/post-merge"), "utf8");
    expect(text).toContain(`"$iw_env_bin" env pull --quiet -f 'apps/web/.infraenv'`);
    expect(text).toContain("[ ! -f 'apps/web/config/app.env' ]");
    expect(existsSync(hook("post-merge"))).toBe(false);
  });

  it("replaces a block an older version wrote", async () => {
    write(join(dir, ".infraenv"), INFRAENV);
    const old = [
      "#!/bin/sh",
      "# >>> infrawrench env >>>",
      "if [ -f '.infraenv' ] && command -v infrawrench >/dev/null 2>&1; then",
      "  infrawrench env pull --quiet -f '.infraenv' || true",
      "fi",
      "# <<< infrawrench env <<<",
      "",
    ].join("\n");
    write(hook("post-merge"), old);
    expect(await run("env", "hooks", "install")).toBe(0);
    expect(out.stdout).toContain("post-merge     updated\n");
    expect(readFileSync(hook("post-merge"), "utf8")).toBe(
      `#!/bin/sh\n${infraenvHookBlock("post-merge", { file: ".infraenv", output: ".env" })}\n`,
    );
  });

  it.skipIf(process.platform === "win32")(
    "falls back to infrawrench, skips file checkouts and amends, and never fails git",
    async () => {
      write(join(dir, ".infraenv"), INFRAENV);
      expect(await run("env", "hooks", "install")).toBe(0);
      // A stand-in `infrawrench` that records its arguments and fails. No
      // node_modules/.bin/infraenv and no `infraenv` on PATH, so the block
      // falls through to it; .env is missing, so every hook that runs pulls.
      const bin = join(dir, "bin");
      const log = join(dir, "calls.log");
      write(join(bin, "infrawrench"), `#!/bin/sh\necho "$*" >> '${log}'\nexit 3\n`);
      chmodSync(join(bin, "infrawrench"), 0o755);
      const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, INFRAENV_HOOK_FOREGROUND: "1" };
      const runHook = (name: string, ...args: string[]) =>
        execFileSync("sh", [hook(name), ...args], { cwd: dir, env });

      runHook("post-checkout", "a", "b", "0");
      runHook("post-rewrite", "amend");
      expect(existsSync(log)).toBe(false);
      runHook("post-checkout", "a", "b", "1");
      runHook("post-rewrite", "rebase");
      runHook("post-merge", "0");
      runHook("post-commit");
      expect(readFileSync(log, "utf8")).toBe("env pull --quiet -f .infraenv\n".repeat(4));
      // Without the CLI on PATH the hooks still succeed.
      execFileSync("sh", [hook("post-merge"), "0"], {
        cwd: dir,
        env: { ...process.env, PATH: "/usr/bin:/bin" },
      });
    },
  );

  it("refuses outside a repository", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "iw-env-norepo-")));
    cwd = outside;
    try {
      expect(await run("env", "hooks", "install")).toBe(1);
      expect(out.stderr).toContain("Not inside a Git repository");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
