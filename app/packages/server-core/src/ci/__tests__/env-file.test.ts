import { describe, expect, it } from "vitest";
import { vi } from "vitest";

// These modules import the database client at load; every read here goes
// through the seams instead.
vi.mock("../../db/client.js", () => ({ db: {} }));

const { checkEnvFileForCi, envFileKey, envFileRequests, lendEnvFiles } =
  await import("../env-file");
const { accessFrom } = await import("../concurrency");
const { namesSomethingLent } = await import("../runs");
const { needsLending } = await import("../lend");

type Deps = NonNullable<Parameters<typeof lendEnvFiles>[2]>;
type Grant = Awaited<ReturnType<Deps["grants"]>>[number];

const run = {
  id: "run-1",
  organizationId: "org-1",
  repoFullName: "acme/web",
  event: "push" as const,
  headRef: "main",
  fromFork: false,
  installationId: 42,
  sha: "abcdef1234567890",
};

const DB = {
  id: "neon:acct:br-1",
  pluginId: "neon",
  resourceTypeId: "neon-branch",
  accountId: "acct",
  parentResourceId: null,
  displayName: "storefront / dev",
  incarnation: 0,
};
const CACHE = {
  id: "upstash:acct:redis-1",
  pluginId: "upstash",
  resourceTypeId: "redis",
  accountId: "acct",
  parentResourceId: null,
  displayName: "cache",
  incarnation: 0,
};

function grant(over: Partial<Grant> & { resourceId: string; ciName: string }): Grant {
  return {
    id: `grant-${over.ciName}`,
    organizationId: "org-1",
    accountId: "acct",
    resourceTypeId: "x",
    resourceName: "x",
    outputs: [],
    secretVersion: null,
    repos: null,
    branchPattern: null,
    resourceIncarnation: 0,
    peerPluginId: null,
    peerLendEnabled: false,
    peerJobKinds: [],
    peerMaxConcurrentJobs: 2,
    peerMaxJobMinutes: 60,
    peerJobRegions: [],
    peerPreflight: {},
    createdByUserId: "user-creator",
    updatedByUserId: "user-admin",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

const FILE = `
[vars]
stage = dev

[env]
NODE_ENV = development
DATABASE_URL = resource("neon/neon-branch", "storefront / \${stage}", "connectionString")
CACHE_URL = resource("upstash:acct:redis-1", "restUrl")
STRIPE_KEY = secret("STRIPE_SECRET_KEY")

[vars.staging]
stage = staging

[env.staging]
NODE_ENV = staging
`;

function deps(over: Partial<Deps> = {}, files: Record<string, string> = { ".infraenv": FILE }) {
  const reads: string[] = [];
  const named: string[] = [];
  const d: Deps = {
    readFile: async (installationId, repo, path, sha) => {
      expect([installationId, repo, sha]).toEqual([42, "acme/web", run.sha]);
      return files[path] ?? null;
    },
    resourcesById: async (_org, ids) => [DB, CACHE].filter((r) => ids.includes(r.id)),
    resourcesNamed: async (_org, match) => {
      named.push(`${match.pluginId}/${match.resourceTypeId}:${match.name}`);
      return [DB, CACHE].filter(
        (r) =>
          r.pluginId === match.pluginId &&
          r.resourceTypeId === match.resourceTypeId &&
          r.displayName === match.name,
      );
    },
    grants: async (_org, ids) =>
      [
        grant({ resourceId: DB.id, ciName: "db", outputs: ["connectionString"] }),
        grant({ resourceId: CACHE.id, ciName: "cache", outputs: ["restUrl"] }),
      ].filter((g) => ids.includes(g.resourceId)),
    reader: {
      read: async (_grant, resource, output) => {
        reads.push(`${resource.id}.${output}`);
        return `value-of-${resource.id}-${output}`;
      },
      envTemplate: async () => null,
    },
    ...over,
  };
  return { deps: d, reads, named };
}

const job = (envFile: { path: string; environment?: string; vars?: Record<string, string> }) => ({
  pipeline: ".infrawrench/ci/test.yml",
  job: "test",
  envFile,
});

describe("env-file: what the runners list", () => {
  it("reads a job's env-file leniently, and counts it as something lent", () => {
    const access = accessFrom({
      pipelines: [
        {
          file: "ci.yml",
          jobs: [
            {
              key: "test",
              "env-file": {
                path: ".infraenv",
                environment: "staging",
                vars: { stage: "ci", n: 1 },
              },
            },
            { key: "bad", "env-file": { environment: "x" } },
          ],
        },
      ],
    });
    expect(access).toEqual([
      {
        pipeline: "ci.yml",
        job: "test",
        envFile: { path: ".infraenv", environment: "staging", vars: { stage: "ci" } },
      },
      { pipeline: "ci.yml", job: "bad" },
    ]);
    expect(namesSomethingLent(access)).toBe(true);
    expect(needsLending(access)).toBe(true);
    expect(namesSomethingLent([access[1]!])).toBe(false);
  });

  it("keys a use exactly as the runner does (`EnvFileUse::key`)", () => {
    expect(envFileKey({ path: ".infraenv" })).toBe('{"path":".infraenv"}');
    // The same strings as iwci-spec's test of the key.
    expect(
      envFileKey({
        path: "apps/web/.infraenv",
        environment: "staging",
        vars: { stage: "ci", region: 'eu "west"' },
      }),
    ).toBe(
      '{"path":"apps/web/.infraenv","environment":"staging","vars":{"region":"eu \\"west\\"","stage":"ci"}}',
    );
    // Jobs reading the same file the same way share one entry.
    expect([
      ...envFileRequests([
        job({ path: ".infraenv", vars: { a: "1", b: "2" } }),
        { ...job({ path: ".infraenv", vars: { b: "2", a: "1" } }), job: "other" },
        { pipeline: "p", job: "plain" },
      ]).keys(),
    ]).toEqual(['{"path":".infraenv","vars":{"a":"1","b":"2"}}']);
  });
});

describe("lending an env-file", () => {
  it("lends granted resources as secrets, literals as text and CI secrets by name", async () => {
    const { deps: d, reads, named } = deps();
    const lent = await lendEnvFiles(run, [job({ path: ".infraenv" })], d);
    expect(lent?.entries).toEqual({
      '{"path":".infraenv"}': {
        env: {
          NODE_ENV: [{ text: "development" }],
          // By name, after `${stage}` is filled in from [vars].
          DATABASE_URL: "value-of-neon:acct:br-1-connectionString",
          // By id.
          CACHE_URL: "value-of-upstash:acct:redis-1-restUrl",
        },
        // A CI secret's name only: the runner fills it from the run's secrets.
        secrets: { STRIPE_KEY: "STRIPE_SECRET_KEY" },
      },
    });
    expect(named).toEqual(["neon/neon-branch:storefront / dev"]);
    expect(reads.sort()).toEqual([
      "neon:acct:br-1.connectionString",
      "upstash:acct:redis-1.restUrl",
    ]);
    // Audited by name, never by value, with who allowed each read.
    const records = lent!.records;
    expect(records.map((r) => [r.kind, r.name, r.allowedBy])).toEqual([
      ["resource", "cache", "user-admin"],
      ["resource", "db", "user-admin"],
      ["env-file", ".infraenv", null],
    ]);
    expect(records[2]!.summary).toContain("STRIPE_KEY (CI secret STRIPE_SECRET_KEY)");
    expect(JSON.stringify(records)).not.toContain("value-of-");
  });

  it("substitutes the job's vars over the file's and the environment's", async () => {
    const { deps: d, named } = deps({
      resourcesNamed: async (_org, match) => {
        named.push(match.name);
        return [{ ...DB, displayName: match.name }];
      },
    });
    const lent = await lendEnvFiles(
      run,
      [
        job({ path: ".infraenv", environment: "staging" }),
        { ...job({ path: ".infraenv", environment: "staging", vars: { stage: "ci" } }), job: "b" },
      ],
      d,
    );
    expect(named).toEqual(["storefront / staging", "storefront / ci"]);
    const staging = lent!.entries['{"path":".infraenv","environment":"staging"}'];
    expect(staging).toMatchObject({ env: { NODE_ENV: [{ text: "staging" }] } });
  });

  it("refuses the file when a resource is not granted, naming the variable and what to grant", async () => {
    const { deps: d, reads } = deps({
      grants: async () => [
        grant({ resourceId: DB.id, ciName: "db", outputs: ["connectionString"] }),
      ],
    });
    const lent = await lendEnvFiles(run, [job({ path: ".infraenv" })], d);
    const entry = lent!.entries['{"path":".infraenv"}'] as { refused: string };
    expect(entry.refused).toBe(
      "`CACHE_URL` in .infraenv reads restUrl of cache (upstash/redis), which is not granted to CI; grant cache to CI with the output restUrl for acme/web",
    );
    // Nothing is read, or audited, for a refused file.
    expect(reads).toEqual([]);
    expect(lent!.records).toEqual([]);
  });

  it("refuses an output the grant does not tick", async () => {
    const { deps: d } = deps({
      grants: async () => [
        grant({ resourceId: DB.id, ciName: "db", outputs: ["host"] }),
        grant({ resourceId: CACHE.id, ciName: "cache", outputs: ["restUrl"] }),
      ],
    });
    const lent = await lendEnvFiles(run, [job({ path: ".infraenv" })], d);
    expect((lent!.entries['{"path":".infraenv"}'] as { refused: string }).refused).toBe(
      "`DATABASE_URL` in .infraenv reads connectionString of storefront / dev (neon/neon-branch), an output that is not granted to CI; tick connectionString on its grant (db)",
    );
  });

  it("checks a by-name reference's grant like any other: its repository, branch and incarnation", async () => {
    const narrow = deps({
      grants: async () => [
        grant({
          resourceId: DB.id,
          ciName: "db",
          outputs: ["connectionString"],
          branchPattern: "release/*",
        }),
        grant({ resourceId: CACHE.id, ciName: "cache", outputs: ["restUrl"] }),
      ],
    });
    const lent = await lendEnvFiles(run, [job({ path: ".infraenv" })], narrow.deps);
    expect((lent!.entries['{"path":".infraenv"}'] as { refused: string }).refused).toContain(
      "which is not granted to CI for acme/web on main; widen its grant (db)",
    );
    const recreated = deps({
      grants: async () => [
        grant({
          resourceId: DB.id,
          ciName: "db",
          outputs: ["connectionString"],
          resourceIncarnation: 3,
        }),
        grant({ resourceId: CACHE.id, ciName: "cache", outputs: ["restUrl"] }),
      ],
    });
    const again = await lendEnvFiles(run, [job({ path: ".infraenv" })], recreated.deps);
    expect((again!.entries['{"path":".infraenv"}'] as { refused: string }).refused).toContain(
      "deleted and created again",
    );
    // An ambiguous or missing name is refused before any grant is looked at.
    const ambiguous = deps({ resourcesNamed: async () => [DB, { ...DB, id: "neon:b:br-2" }] });
    const many = await lendEnvFiles(run, [job({ path: ".infraenv" })], ambiguous.deps);
    expect((many!.entries['{"path":".infraenv"}'] as { refused: string }).refused).toContain(
      "and 2 match; add the account",
    );
  });

  it("lends a fork's run nothing", async () => {
    const { deps: d, reads } = deps({
      readFile: async () => {
        throw new Error("a fork's file is never read");
      },
    });
    expect(
      await lendEnvFiles({ ...run, fromFork: true }, [job({ path: ".infraenv" })], d),
    ).toBeNull();
    expect(await lendEnvFiles(run, [{ pipeline: "p", job: "j" }], d)).toBeNull();
    expect(await lendEnvFiles(run, null, d)).toBeNull();
    expect(reads).toEqual([]);
  });

  it("refuses a file that is missing, broken, pinned elsewhere or lacks the environment", async () => {
    const files = {
      broken: "[env]\nA = resource(\n",
      pinned: "[infrawrench]\norg = org-2\n[env]\nA = 1\n",
      runner: "[env]\nIWCI_JOB = x\n",
      unset: '[env]\nA = resource("neon/neon-branch", "${nope}", "host")\n',
    };
    const { deps: d } = deps({}, { ...files, ".infraenv": FILE });
    const lent = await lendEnvFiles(
      run,
      [
        job({ path: "missing" }),
        job({ path: "broken" }),
        job({ path: "pinned" }),
        job({ path: "runner" }),
        job({ path: "unset" }),
        job({ path: ".infraenv", environment: "prod" }),
      ],
      d,
    );
    const reasons = Object.values(lent!.entries).map((e) => (e as { refused: string }).refused);
    expect(reasons).toEqual([
      "missing is not in acme/web at abcdef1",
      expect.stringContaining("broken has a problem: line 2: Malformed reference"),
      expect.stringContaining("pinned is pinned to another organization"),
      expect.stringContaining("`IWCI_JOB` in runner (line 2): `IWCI_*` variables are the runner's"),
      expect.stringContaining("No value for ${nope}"),
      ".infraenv has no [env.prod] section",
    ]);
  });
});

describe("checkEnvFileForCi", () => {
  it("reports what each variable would give, reading no value", async () => {
    const d = deps();
    const out = await checkEnvFileForCi(run, { path: ".infraenv" }, d.deps);
    expect(d.reads).toEqual([]);
    expect(out.refused).toBeNull();
    expect(
      out.variables.map((v) => [
        v.key,
        v.kind,
        v.refused ?? null,
        v.resource?.grant ?? v.secret ?? null,
      ]),
    ).toEqual([
      ["NODE_ENV", "literal", null, null],
      ["DATABASE_URL", "resource", null, "db"],
      ["CACHE_URL", "resource", null, "cache"],
      ["STRIPE_KEY", "ci-secret", null, "STRIPE_SECRET_KEY"],
    ]);
  });

  it("lists every refusal, not only the first", async () => {
    const d = deps({ grants: async () => [] });
    const out = await checkEnvFileForCi(run, { path: ".infraenv", environment: "staging" }, d.deps);
    const refused = out.variables.filter((v) => v.refused).map((v) => v.key);
    expect(refused).toEqual(["DATABASE_URL", "CACHE_URL"]);
    expect(out.variables.find((v) => v.key === "DATABASE_URL")!.refused).toMatch(
      /No neon\/neon-branch named "storefront \/ staging"/,
    );
    expect(out.variables.find((v) => v.key === "CACHE_URL")!.refused).toMatch(/not granted to CI/);
  });

  it("refuses the whole file when it is missing", async () => {
    const out = await checkEnvFileForCi(run, { path: "nope/.infraenv" }, deps().deps);
    expect(out.refused).toMatch(/is not in acme\/web/);
  });
});
