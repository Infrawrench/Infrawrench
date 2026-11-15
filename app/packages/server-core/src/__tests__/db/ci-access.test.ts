/**
 * CI access against a real Postgres: what a run is lent at dispatch (its
 * opt-ins, refusals and audit rows), and a cloud job's whole life (claim,
 * start, the machine's callback relayed to the runner, teardown, and the
 * reaper). The CI proxy, GitHub and the plugins are fakes: no provider is
 * ever called, and the plugin registry is two fake plugins, because loading
 * the real one imports every bundled plugin and its SDK, which on a busy
 * host took longer than a test may.
 *
 * Every test makes an organization of its own and removes it after, so a
 * test that fails leaves nothing for the next one to trip on. The modules
 * are loaded once in `beforeAll`, under the hook's budget, not a test's.
 *
 * Skipped unless DATABASE_URL is set, migrations applied, scratch databases
 * only: it writes organizations and their rows, and deletes them after.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const configured = !!process.env["DATABASE_URL"];
process.env["ENCRYPTION_MASTER_KEY"] ??= randomBytes(32).toString("base64");
process.env["APP_URL"] ??= "https://app.example.test";
process.env["CI_PROXY_URL"] ??= "https://ci-proxy.example.test";

interface ProxyCall {
  path: string;
  body: Record<string, unknown> | null;
}

const proxy = {
  calls: [] as ProxyCall[],
  pipelines: [] as unknown[],
  cloudJobs: [] as Array<Record<string, unknown>>,
  next: 0,
  /** Answer the next N claims with a 503, as a busy proxy would. */
  claimFailures: 0,
  /** Answer the next N run requests with a 503. */
  runFailures: 0,
  /** What `POST /v1/schedules/read` answers. */
  scheduled: [] as unknown[],
};

/** What the fake plugins were asked. */
const plugins = {
  started: [] as Array<Record<string, unknown>>,
  tornDown: [] as string[],
  tagged: [] as Array<Record<string, unknown>>,
};

/**
 * The two providers these tests use, as the registry and an account's client
 * both describe them.
 */
const fakePlugins = vi.hoisted(() => ({
  aws: {
    manifest: {
      id: "aws",
      displayName: "Amazon Web Services",
      credentialFields: [],
      ciExecutor: {
        kinds: [{ kind: "vm", label: "EC2 instance", defaults: { machine: "t3.large" } }],
      },
    },
    resourceTypes: [
      {
        id: "rds-instance",
        outputs: [
          { key: "connectionString", label: "Connection string", sensitive: true },
          { key: "endpoint", label: "Endpoint", sensitive: false },
          { key: "password", label: "Password", sensitive: true },
        ],
        // A managed database: lent as `postgres` when it runs PostgreSQL.
        peerIntegrations: [
          {
            pluginId: "postgres",
            credentialMappings: [
              { outputKey: "connectionString", credentialKey: "connectionString" },
            ],
            tabLabel: "PostgreSQL",
            showWhen: { fieldKey: "engine", equals: "postgres" },
          },
        ],
      },
      {
        id: "eks-cluster",
        outputs: [{ key: "kubeconfig", label: "Kubeconfig", sensitive: true }],
        // A managed cluster: lent, and run on, as `kubernetes`.
        peerIntegrations: [
          {
            pluginId: "kubernetes",
            credentialMappings: [{ outputKey: "kubeconfig", credentialKey: "kubeconfig" }],
            tabLabel: "Kubernetes",
          },
        ],
      },
    ],
  },
  postgres: {
    manifest: {
      id: "postgres",
      displayName: "PostgreSQL",
      ciCredential: { description: "DATABASE_URL", shortLived: false },
      credentialFields: [{ key: "connectionString", label: "c", sensitive: true }],
    },
    resourceTypes: [],
  },
  kubernetes: {
    manifest: {
      id: "kubernetes",
      displayName: "Kubernetes",
      ciCredential: {
        description: "x",
        shortLived: false,
        tools: [
          {
            command: "kubectl",
            downloads: {
              x86_64: { url: "https://dl.example.test/kubectl", sha256: "a".repeat(64) },
            },
          },
        ],
      },
      ciExecutor: {
        kinds: [{ kind: "cluster", label: "Kubernetes Job", defaults: { image: "busybox" } }],
      },
      credentialFields: [{ key: "kubeconfig", label: "k", sensitive: true }],
    },
    resourceTypes: [],
  },
}));

vi.mock("../../plugin-loader.js", () => {
  const loaded = Object.values(fakePlugins).map((plugin) => ({ plugin }));
  return {
    pluginCodeAvailable: () => true,
    loadPlugins: async () => loaded,
    getPlugin: async (pluginId: string) => loaded.find((l) => l.plugin.manifest.id === pluginId),
  };
});

vi.mock("../../features.js", () => ({ orgHasFeature: async () => true }));
vi.mock("../../entitlements.js", () => ({ planAccess: async () => ({ paid: true }) }));
vi.mock("../../github/app.js", () => ({
  getInstallationToken: async () => "installation-token-for-tests",
  githubInstallationFetch: async () =>
    new Response(JSON.stringify({ id: 1 }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
}));

vi.mock("../../org-accounts.js", () => ({
  getOrgAccountClient: async (accountId: string) => {
    if (accountId.startsWith("acc-k8s")) {
      return {
        credentials: {},
        plugin: fakePlugins.kubernetes,
        client: {
          lendCiCredential: async (req: { alias: string }) => ({
            env: { KUBECONFIG: [{ text: `/root/.kube/${req.alias}.yaml` }] },
            files: [
              {
                path: `/root/.kube/${req.alias}.yaml`,
                content: [{ text: "token: " }, { secret: "minted-token-for-tests" }],
              },
            ],
            summary: "a minted token",
          }),
        },
      };
    }
    return {
      credentials: {},
      plugin: fakePlugins.aws,
      client: {
        ciStart: async (spec: Record<string, unknown>) => {
          plugins.started.push(spec);
          return { id: "i-test", region: "eu-west-1", label: "aws ec2 i-test (eu-west-1)" };
        },
        ciTeardown: async (handle: { id: string }) => {
          plugins.tornDown.push(handle.id);
        },
        ciListTagged: async () => plugins.tagged,
        ciPreflight: async () => ({ ok: true, missing: [], problems: [], region: "eu-west-1" }),
      },
    };
  },
}));

/** What the fake peers were asked, and whether the cluster passes its check. */
const peers = vi.hoisted(() => ({
  asked: [] as Array<{ pluginId: string; accountId: string; resourceId: string | undefined }>,
  preflightOk: true,
}));

vi.mock("../../peer-clients.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../peer-clients.js")>();
  return {
    ...real,
    // The peer a resource exposes, as `getClientForResource` builds it from
    // the resource's outputs; otherwise the account's own client, which
    // reads outputs.
    getClientForResource: async (
      pluginId: string,
      accountId: string,
      _organizationId: string,
      resourceId?: string,
    ) => {
      peers.asked.push({ pluginId, accountId, resourceId });
      if (pluginId === "kubernetes" && resourceId?.includes(":eks-cluster:")) {
        return {
          credentials: { kubeconfig: "inline" },
          plugin: fakePlugins.kubernetes,
          client: {
            lendCiCredential: async (req: { alias: string; namespace?: string }) => ({
              env: { KUBECONFIG: [{ text: `/root/.kube/${req.alias}.yaml` }] },
              files: [
                {
                  path: `/root/.kube/${req.alias}.yaml`,
                  content: [
                    { text: `namespace: ${req.namespace ?? "default"}\ntoken: ` },
                    { secret: "peer-token-for-tests" },
                  ],
                },
              ],
              summary: "the kubeconfig's token",
            }),
            ciPreflight: async () =>
              peers.preflightOk
                ? { ok: true, missing: [], problems: [] }
                : {
                    ok: false,
                    missing: [{ permission: "create jobs.batch", label: "start jobs" }],
                    problems: [],
                  },
            ciStart: async (spec: Record<string, unknown>) => {
              plugins.started.push({ ...spec, via: "kubernetes" });
              return { id: "default/iwci-job", label: "kubernetes job default/iwci-job" };
            },
            ciTeardown: async (handle: { id: string }) => {
              plugins.tornDown.push(`peer:${handle.id}`);
            },
            ciListTagged: async () => [],
          },
        };
      }
      if (pluginId === "postgres" && resourceId?.includes(":rds-instance:")) {
        return {
          credentials: { connectionString: "postgres://user:pw@db.example.test/app" },
          plugin: fakePlugins.postgres,
          client: {
            lendCiCredential: async () => ({
              env: { DATABASE_URL: "postgres://user:pw@db.example.test/app" },
              files: [],
              summary: "the connection string",
            }),
          },
        };
      }
      return {
        plugin: fakePlugins.aws,
        client: {
          resolveOutput: async (_type: string, _id: string, key: string) =>
            key === "connectionString" ? "postgres://user:pw@db.example.test/app" : "",
        },
      };
    },
  };
});

vi.mock("../../ci/proxy.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../ci/proxy.js")>();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const proxyFetch = async (path: string, init: RequestInit = {}) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    proxy.calls.push({ path, body });
    if (path === "/v1/concurrency") return json(200, { pipelines: proxy.pipelines });
    if (path === "/v1/schedules/read") {
      return json(200, { commit: body?.["sha"] ?? "f".repeat(40), pipelines: proxy.scheduled });
    }
    if (path === "/v1/runs") {
      if (proxy.runFailures > 0) {
        proxy.runFailures--;
        return json(503, { error: "busy" });
      }
      const id = `ci-1.${(++proxy.next).toString(16).padStart(32, "0")}`;
      return json(202, { id, state: "running" });
    }
    const one = /^\/v1\/runs\/[^/]+\/jobs\/([^/]+)$/.exec(path);
    if (one) {
      const spec = proxy.cloudJobs.find((j) => j["job"] === decodeURIComponent(one[1] ?? ""));
      return spec ? json(200, spec) : json(404, { error: "no such job" });
    }
    if (/^\/v1\/runs\/[^/]+\/jobs$/.test(path))
      return json(200, { run: "x", jobs: proxy.cloudJobs });
    if (path.endsWith("/claim")) {
      if (proxy.claimFailures > 0) {
        proxy.claimFailures--;
        return json(503, { error: "busy" });
      }
      return json(200, {
        ...proxy.cloudJobs[0],
        claim: "c".repeat(32),
        env: { CI: "true", TOKEN: "secret-env-for-tests" },
        files: [],
        inputs: null,
        artifacts: null,
      });
    }
    if (path.endsWith("/log")) return json(200, { state: "claimed", lease_secs: 300 });
    if (path.endsWith("/finish")) return json(200, { state: "finished" });
    return json(404, { error: "no such run" });
  };
  return {
    ...real,
    ciProxyConfigured: () => true,
    proxyFetch,
    proxyJson: async (path: string, init?: RequestInit) => {
      const res = await proxyFetch(path, init);
      if (!res.ok) throw new real.CiProxyError("no", res.status);
      return res.json();
    },
  };
});

/** One test's organization: its member, its GitHub account and what CI can be lent. */
interface TestOrg {
  orgId: string;
  userId: string;
  installationId: number;
  k8sId: string;
  awsId: string;
  resourceId: string;
  keyId: string;
  /** Every user made for it, removed with it. */
  users: string[];
}

const installationBase = 910_000_000 + Math.floor(Math.random() * 1_000_000);
let installations = 0;
let sha = 0;

/** What the opted-in organization's AWS connection may do: run `vm` jobs on `main`. */
const JOB_SETTINGS = {
  jobsEnabled: true,
  jobKinds: ["vm" as const],
  maxConcurrentJobs: 1,
  maxJobMinutes: 60,
  jobRepos: null,
  jobBranchPattern: "main",
  lendEnabled: false,
  lendRepos: null,
  lendBranchPattern: null,
};
/** What its cluster may do: be lent to runs on `main`. */
const LEND_SETTINGS = {
  ...JOB_SETTINGS,
  jobsEnabled: false,
  jobKinds: [],
  lendEnabled: true,
  lendBranchPattern: "main",
};
const KEY_LENDING = { enabled: true, ciName: "deploy", repos: null, branchPattern: null };
const grantOf = (resourceId: string) => ({
  resourceId,
  ciName: "prod-db",
  outputs: ["connectionString"],
  secretVersion: null,
  repos: ["acme/web"],
  branchPattern: null,
});

describe.skipIf(!configured)("CI access against a real Postgres", () => {
  async function load() {
    const { db } = await import("../../db/client");
    const schema = await import("../../db/schema");
    const runs = await import("../../ci/runs");
    const access = await import("../../ci/access");
    const cloud = await import("../../ci/cloud-jobs");
    const schedules = await import("../../ci/schedules");
    // `runs` imports this when a run is first lent something: loaded here, so
    // no test pays for it.
    await import("../../ci/lend");
    const { encrypt, buildAad } = await import("../../encryption");
    const { and, eq } = await import("drizzle-orm");
    return { db, schema, runs, access, cloud, schedules, encrypt, buildAad, and, eq };
  }
  let m: Awaited<ReturnType<typeof load>>;
  const made: TestOrg[] = [];

  beforeAll(async () => {
    m = await load();
  });

  beforeEach(() => {
    Object.assign(proxy, {
      calls: [],
      pipelines: [],
      cloudJobs: [],
      claimFailures: 0,
      runFailures: 0,
      scheduled: [],
    });
    Object.assign(plugins, { started: [], tornDown: [], tagged: [] });
  });

  /**
   * An organization with two connections, a resource and an SSH key. With
   * `optedIn`, everything is lent as the first test checks it can be: the
   * AWS connection runs `vm` jobs and the cluster is lent on `main`, the
   * resource is granted as `prod-db` and the key is lent as `deploy`.
   */
  async function organization(options: { optedIn: boolean }): Promise<TestOrg> {
    const { db, schema, access, encrypt, buildAad } = m;
    const awsId = `acc-aws-${randomUUID()}`;
    const org: TestOrg = {
      orgId: `test-org-${randomUUID()}`,
      userId: `test-user-${randomUUID()}`,
      installationId: installationBase + ++installations,
      k8sId: `acc-k8s-${randomUUID()}`,
      awsId,
      resourceId: `${awsId}:rds-instance:prod`,
      keyId: randomUUID(),
      users: [],
    };
    const { orgId, userId, installationId, keyId } = org;
    org.users.push(userId);
    made.push(org);
    await db.insert(schema.users).values({ id: userId, email: `${userId}@example.test` });
    await db.insert(schema.organizations).values({ id: orgId, displayName: "CI access test" });
    await db
      .insert(schema.organizationMembers)
      .values({ id: randomUUID(), userId, organizationId: orgId, role: "admin" });
    await db.insert(schema.githubInstallations).values({
      id: randomUUID(),
      organizationId: orgId,
      installationId,
      accountLogin: "acme",
    } as typeof schema.githubInstallations.$inferInsert);
    await db.insert(schema.ciAccounts).values({
      id: randomUUID(),
      organizationId: orgId,
      installationId,
      accountLogin: "acme",
    });
    for (const [id, pluginId, displayName] of [
      [org.k8sId, "kubernetes", "Production cluster"],
      [org.awsId, "aws", "Production"],
    ] as const) {
      await db.insert(schema.accounts).values({
        id,
        organizationId: orgId,
        pluginId,
        displayName,
        encryptedCredentials: "unused",
        credentialsIv: "unused",
      } as typeof schema.accounts.$inferInsert);
    }
    await db.insert(schema.resources).values({
      id: org.resourceId,
      organizationId: orgId,
      pluginId: "aws",
      resourceTypeId: "rds-instance",
      accountId: org.awsId,
      displayName: "prod-db",
    } as typeof schema.resources.$inferInsert);
    const pub = await encrypt("ssh-ed25519 AAAA test", buildAad("sshKey", keyId, "publicKey"));
    const priv = await encrypt(
      "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----",
      buildAad("sshKey", keyId, "privateKey"),
    );
    await db.insert(schema.sshKeys).values({
      id: keyId,
      organizationId: orgId,
      userId,
      name: "deploy key",
      encryptedPublicKey: pub.ciphertext,
      publicKeyIv: pub.iv,
      encryptedPrivateKey: priv.ciphertext,
      privateKeyIv: priv.iv,
    });
    if (options.optedIn) {
      await access.preflightConnection(orgId, org.awsId, "vm", undefined);
      await access.setConnectionAccess(orgId, org.awsId, JOB_SETTINGS, userId);
      await access.setConnectionAccess(orgId, org.k8sId, LEND_SETTINGS, userId);
      await access.createGrant(orgId, grantOf(org.resourceId), userId);
      await access.setSshKeyLending(orgId, userId, keyId, KEY_LENDING);
    }
    return org;
  }

  async function push(org: TestOrg, branch: string, pipelines: unknown[]): Promise<string> {
    const { runs, db, schema, eq } = m;
    proxy.pipelines = pipelines;
    const accepted = await runs.acceptCiEvent({
      kind: "push",
      baseSha: null,
      installationId: org.installationId,
      repoFullName: "acme/web",
      branch,
      sha: (++sha).toString(16).padStart(40, "0"),
      defaultBranch: "main",
      actorLogin: "octocat",
    });
    if (!accepted) throw new Error("not accepted");
    await db
      .update(schema.ciRuns)
      .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.ciRuns.id, accepted.id));
    await runs.dispatchRun(accepted.id);
    return accepted.id;
  }

  // Runs whether the test passed or not, so the next one starts with no run,
  // cloud job or schedule of this one's for a pass to pick up.
  afterEach(async () => {
    const { db, schema, eq } = m;
    for (const org of made.splice(0)) {
      const { orgId } = org;
      await db.delete(schema.auditLogs).where(eq(schema.auditLogs.organizationId, orgId));
      await db.delete(schema.ciRuns).where(eq(schema.ciRuns.organizationId, orgId));
      await db.delete(schema.ciAccounts).where(eq(schema.ciAccounts.organizationId, orgId));
      await db
        .delete(schema.githubInstallations)
        .where(eq(schema.githubInstallations.organizationId, orgId));
      await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
      for (const id of org.users) await db.delete(schema.users).where(eq(schema.users.id, id));
    }
  });

  afterAll(async () => {
    await m?.db.$client.end();
  });

  it("opts in only what passes its checks", async () => {
    const { access } = m;
    const { orgId, userId, awsId, k8sId, resourceId, keyId } = await organization({
      optedIn: false,
    });
    // Not yet checked: refused.
    await expect(access.setConnectionAccess(orgId, awsId, JOB_SETTINGS, userId)).rejects.toThrow(
      "Check the connection's permissions",
    );
    const checked = await access.preflightConnection(orgId, awsId, "vm", undefined);
    expect(checked.preflight["vm"]?.ok).toBe(true);
    const saved = await access.setConnectionAccess(orgId, awsId, JOB_SETTINGS, userId);
    expect(saved.settings.jobsEnabled).toBe(true);
    // AWS lends nothing.
    await expect(
      access.setConnectionAccess(orgId, awsId, { ...JOB_SETTINGS, lendEnabled: true }, userId),
    ).rejects.toThrow("cannot be lent");

    const lent = await access.setConnectionAccess(orgId, k8sId, LEND_SETTINGS, userId);
    expect(lent.settings.lendEnabled).toBe(true);

    const grant = await access.createGrant(orgId, grantOf(resourceId), userId);
    expect(grant.ciName).toBe("prod-db");
    await expect(
      access.createGrant(
        orgId,
        { ...grant, outputs: ["connectionString"], resourceId, secretVersion: null },
        userId,
      ),
    ).rejects.toThrow("already called prod-db");

    const overview = await access.ciAccessOverview(orgId, userId);
    expect(overview.sshKeys).toEqual([]);
    await expect(
      access.setSshKeyLending(orgId, "someone-else", keyId, KEY_LENDING),
    ).rejects.toThrow("No such SSH key of yours");
    const lending = await access.setSshKeyLending(orgId, userId, keyId, KEY_LENDING);
    expect(lending).toMatchObject({ ciName: "deploy", mine: true });
  });

  it("lends a trusted run what its jobs name, refusing the rest by name", async () => {
    const { db, schema, eq } = m;
    const org = await organization({ optedIn: true });
    proxy.calls = [];
    const id = await push(org, "main", [
      {
        file: ".infrawrench/ci/deploy.yml",
        name: "Deploy",
        concurrency: null,
        jobs: [
          {
            key: "deploy",
            connections: [{ name: "Production cluster" }, { name: "Nope" }],
            "ssh-keys": ["deploy", "other"],
            resources: { "prod-db": ["connectionString", "password"] },
          },
        ],
      },
    ]);
    const sent = proxy.calls.find((c) => c.path === "/v1/runs")?.body ?? {};
    expect(sent["lent"]).toEqual({
      connections: {
        "Production cluster": {
          env: { KUBECONFIG: [{ text: "/root/.kube/production-cluster.yaml" }] },
          files: [
            {
              path: "/root/.kube/production-cluster.yaml",
              content: [{ text: "token: " }, { secret: "minted-token-for-tests" }],
            },
          ],
        },
        Nope: { refused: "no connection is called `Nope`" },
      },
      "ssh-keys": {
        deploy: {
          files: [
            {
              path: "/root/.ssh/id_deploy",
              mode: "600",
              content:
                "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n",
            },
            {
              path: "/root/.ssh/config",
              mode: "600",
              content: [{ text: "Host *\n  IdentityFile /root/.ssh/id_deploy\n" }],
            },
          ],
        },
        other: { refused: "SSH key `other` is not lent to CI" },
      },
      resources: {
        "prod-db": {
          outputs: { connectionString: "postgres://user:pw@db.example.test/app" },
          "refused-outputs": { password: "password of prod-db is not granted to CI" },
        },
      },
    });
    const [run] = await db.select().from(schema.ciRuns).where(eq(schema.ciRuns.id, id));
    expect(run?.status).toBe("running");
    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.organizationId, org.orgId));
    const lends = audits.filter((a) => a.action === "ci.lend");
    expect(lends.map((a) => (a.metadata as { name: string }).name).sort()).toEqual([
      "Production cluster",
      "deploy",
      "prod-db",
    ]);
    expect(lends.every((a) => a.userId === org.userId)).toBe(true);
    // Nothing secret in the audit log.
    expect(JSON.stringify(lends)).not.toContain("minted-token-for-tests");
  });

  it("refuses a branch outside the permission", async () => {
    const org = await organization({ optedIn: true });
    proxy.calls = [];
    await push(org, "feature/x", [
      {
        file: ".infrawrench/ci/deploy.yml",
        name: "Deploy",
        concurrency: null,
        jobs: [{ key: "deploy", connections: [{ name: "Production cluster" }] }],
      },
    ]);
    const sent = proxy.calls.find((c) => c.path === "/v1/runs")?.body ?? {};
    expect(sent["lent"]).toEqual({
      connections: {
        "Production cluster": {
          refused: "connection `Production cluster` is not lent to CI for acme/web on feature/x",
        },
      },
    });
  });

  it("lends a scheduled run what the default branch is lent, as a push to it", async () => {
    const { db, schema, eq, and, schedules, runs } = m;
    const org = await organization({ optedIn: true });
    const deploy = {
      file: ".infrawrench/ci/nightly.yml",
      name: "Nightly",
      concurrency: null,
      jobs: [{ key: "deploy", connections: [{ name: "Production cluster" }] }],
    };
    proxy.scheduled = [
      {
        file: deploy.file,
        name: deploy.name,
        cron: ["* * * * *"],
        text: "name: Nightly\non:\n  schedule:\n    - cron: '* * * * *'\n",
      },
    ];
    // A push to the default branch registers the repository and asks for a read.
    await push(org, "main", []);
    await schedules.refreshSchedules(1_000);
    const [registered] = await db
      .select()
      .from(schema.ciSchedules)
      .where(eq(schema.ciSchedules.organizationId, org.orgId));
    expect(registered?.pipelines.map((p) => p.file)).toEqual([deploy.file]);

    await schedules.fireDueSchedules();
    const [scheduled] = await db
      .select()
      .from(schema.ciRuns)
      .where(and(eq(schema.ciRuns.organizationId, org.orgId), eq(schema.ciRuns.event, "schedule")));
    expect(scheduled).toMatchObject({
      branch: "main",
      headRef: "main",
      fromFork: false,
      pipelineFile: deploy.file,
      status: "queued",
    });

    proxy.pipelines = [deploy];
    proxy.calls = [];
    await db
      .update(schema.ciRuns)
      .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.ciRuns.id, scheduled!.id));
    await runs.dispatchRun(scheduled!.id);
    const sent = proxy.calls.find((c) => c.path === "/v1/runs")?.body ?? {};
    expect(sent).toMatchObject({
      event: "schedule",
      branch: "main",
      pipeline: (proxy.scheduled[0] as { text: string }).text,
    });
    // Not a pull request, so the proxy adds secrets without `trusted`.
    expect(sent["trusted"]).toBeUndefined();
    // The connection is lent on `main` only, which is the branch it runs on.
    expect(sent["lent"]).toMatchObject({
      connections: { "Production cluster": { files: expect.any(Array) } },
    });
    const lends = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.organizationId, org.orgId));
    expect(
      lends.some(
        (a) => a.action === "ci.lend" && (a.metadata as { runId: string }).runId === scheduled!.id,
      ),
    ).toBe(true);
  });

  it("runs a cloud job from claim to teardown, and reaps what nothing owns", async () => {
    const { db, schema, eq, cloud } = m;
    const org = await organization({ optedIn: true });
    const { orgId } = org;
    const runId = await push(org, "main", [
      {
        file: ".infrawrench/ci/build.yml",
        name: "Build",
        concurrency: null,
        jobs: [
          {
            key: "image",
            cloud: { provider: "aws", kind: "vm" },
            connections: ["Production cluster"],
          },
        ],
      },
    ]);
    const spec = {
      run: "x",
      job: "image",
      name: "image",
      pipeline: ".infrawrench/ci/build.yml",
      state: "external",
      cloud: { provider: "aws", kind: "vm" },
      commit: {
        repo: "https://github.com/acme/web",
        sha: "a",
        branch: "main",
        ref: "refs/heads/main",
      },
      clone: { depth: 1, into: "/app" },
      cwd: "/app",
      script: "make image",
      timeout_secs: 1800,
      inputs: null,
      artifacts: null,
    };
    proxy.cloudJobs = [spec];
    proxy.calls = [];
    await cloud.runCiCloudPass();

    const [job] = await db
      .select()
      .from(schema.ciCloudJobs)
      .where(eq(schema.ciCloudJobs.runId, runId));
    expect(job).toMatchObject({ state: "starting", jobId: "image", accountId: org.awsId });
    expect(job?.handle?.label).toBe("aws ec2 i-test (eu-west-1)");
    expect(job?.encryptedClaim).toBeTruthy();
    const started = plugins.started.at(-1)!;
    expect(started).toMatchObject({ kind: "vm", machine: "t3.large", maxSeconds: 2400 });
    expect(started["tags"]).toMatchObject({
      "infrawrench-ci": `org-${orgId}`,
      "infrawrench-ci-job": job?.id,
    });
    // The bootstrap holds the callback, never the job's secrets.
    const bootstrap = String(started["bootstrap"]);
    expect(bootstrap).not.toContain("secret-env-for-tests");
    // The token is in the bootstrap as a variable, sent as a header: never in a URL.
    expect(bootstrap).not.toMatch(/ci-jobs\/[0-9a-f]{64}/);
    const token = /IWCI_TOKEN='([0-9a-f]{64})'/.exec(bootstrap)?.[1] ?? "";
    expect(token).toHaveLength(64);

    // The claim was made, and a starting machine is kept alive.
    expect(
      proxy.calls.some(
        (c) => c.path === "/v1/runs/" + encodeURIComponent(job!.proxyRunId) + "/jobs/image/claim",
      ),
    ).toBe(true);

    // The machine fetches its script once.
    const script = await cloud.cloudJobScript(token);
    expect(script).toContain(Buffer.from("secret-env-for-tests").toString("base64"));
    // The script reports with a token of its own, and the one the machine
    // started with (which stays in its user data) opens nothing any more.
    const session = /IWCI_H='X-Infrawrench-Ci-Job: ([0-9a-f]{64})'/.exec(script)?.[1] ?? "";
    expect(session).toHaveLength(64);
    expect(session).not.toBe(token);
    expect(script).not.toContain(token);
    await expect(cloud.cloudJobScript(token)).rejects.toThrow("No such job");
    await expect(cloud.cloudJobLog(token, "stdout", "forged\n")).rejects.toThrow("No such job");
    await expect(cloud.cloudJobSource(token)).rejects.toThrow("No such job");
    await expect(cloud.cloudJobScript(session)).rejects.toThrow("already fetched");
    // The job names a cluster, so its machine is given what reads a kubeconfig.
    expect(script).toContain("_dl 'kubectl' 'https://dl.example.test/kubectl'");

    proxy.calls = [];
    await cloud.cloudJobLog(session, "stdout", "building\n");
    expect(proxy.calls[0]).toEqual({
      path: `/v1/runs/${encodeURIComponent(job!.proxyRunId)}/jobs/image/log`,
      body: { claim: "c".repeat(32), stream: "stdout", text: "building\n" },
    });
    await cloud.cloudJobFinish(session, {
      status: "passed",
      exitCode: 0,
      timedOut: false,
      body: `${Buffer.from("digest=1\n").toString("base64")}\n`,
    });
    expect(proxy.calls[1]?.body).toEqual({
      claim: "c".repeat(32),
      status: "passed",
      exit_code: 0,
      output: "digest=1\n",
    });
    const [ended] = await db
      .select()
      .from(schema.ciCloudJobs)
      .where(eq(schema.ciCloudJobs.id, job!.id));
    expect(ended).toMatchObject({ state: "tearing_down", outcome: "passed", encryptedClaim: null });
    await expect(cloud.cloudJobLog(session, "stdout", "late\n")).rejects.toThrow("ended");

    // Teardown, then the reaper removes a tagged leftover no live job owns.
    proxy.cloudJobs = [];
    plugins.tagged = [
      {
        handle: { id: "i-stray", region: "eu-west-1", label: "aws ec2 i-stray" },
        tags: { "infrawrench-ci": `org-${orgId}`, "infrawrench-ci-job": "gone" },
        createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        live: true,
      },
      {
        handle: { id: "i-other-org", region: "eu-west-1", label: "x" },
        tags: { "infrawrench-ci": "org-someone-else" },
        createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        live: true,
      },
    ];
    await cloud.runCiCloudPass();
    // The pass reaps every ten minutes; this one already did, at its first tick.
    expect(await cloud.reapTagged()).toBe(1);
    const [done] = await db
      .select()
      .from(schema.ciCloudJobs)
      .where(eq(schema.ciCloudJobs.id, job!.id));
    expect(done?.state).toBe("done");
    expect(plugins.tornDown).toContain("i-test");
    expect(plugins.tornDown).toContain("i-stray");
    expect(plugins.tornDown).not.toContain("i-other-org");
  });

  it("fails a cloud job no connection can run, naming what to opt in", async () => {
    const { cloud } = m;
    const org = await organization({ optedIn: true });
    await push(org, "main", [
      {
        file: ".infrawrench/ci/build.yml",
        name: "Build",
        concurrency: null,
        jobs: [{ key: "image", cloud: { provider: "gcp", kind: "build" } }],
      },
    ]);
    proxy.cloudJobs = [
      {
        job: "image",
        name: "image",
        pipeline: ".infrawrench/ci/build.yml",
        state: "external",
        cloud: { provider: "gcp", kind: "build" },
        timeout_secs: 600,
      },
    ];
    proxy.calls = [];
    await cloud.runCiCloudPass();
    const finish = proxy.calls.find((c) => c.path.endsWith("/jobs/image/finish"));
    expect(finish?.body).toEqual({
      status: "error",
      error: "No `gcp` connection is opted in to cloud jobs. Turn one on in CI, CI access.",
    });
  });

  it("refuses a connection used in two namespaces in one run, by name", async () => {
    const org = await organization({ optedIn: true });
    proxy.calls = [];
    await push(org, "main", [
      {
        file: ".infrawrench/ci/deploy.yml",
        name: "Deploy",
        concurrency: null,
        jobs: [
          { key: "dev", connections: [{ name: "Production cluster", namespace: "dev" }] },
          { key: "prod", connections: [{ name: "Production cluster", namespace: "prod" }] },
        ],
      },
    ]);
    const sent = proxy.calls.find((c) => c.path === "/v1/runs")?.body ?? {};
    const entry = (sent["lent"] as { connections: Record<string, { refused?: string }> })
      .connections["Production cluster"];
    expect(entry?.refused).toContain("more than one namespace in this run (dev, prod)");
  });

  it("audits a lend as soon as it is minted, even when the request then fails", async () => {
    const { db, schema, eq } = m;
    const org = await organization({ optedIn: true });
    proxy.runFailures = 1;
    await push(org, "main", [
      {
        file: ".infrawrench/ci/deploy.yml",
        name: "Deploy",
        concurrency: null,
        jobs: [{ key: "deploy", connections: [{ name: "Production cluster" }] }],
      },
    ]);
    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.organizationId, org.orgId));
    expect(audits.filter((a) => a.action === "ci.lend")).toHaveLength(1);
  });

  it("names whoever last widened a grant as who allowed a read of it", async () => {
    const { db, schema, eq, access } = m;
    const org = await organization({ optedIn: true });
    const { orgId } = org;
    const other = `test-user-${randomUUID()}`;
    // Removed with the organization, after the grant that names them.
    org.users.push(other);
    await db.insert(schema.users).values({ id: other, email: `${other}@example.test` });
    const [grant] = await db
      .select()
      .from(schema.ciResourceGrants)
      .where(eq(schema.ciResourceGrants.organizationId, orgId));
    await access.updateGrant(
      orgId,
      grant!.id,
      {
        resourceId: org.resourceId,
        ciName: "prod-db",
        outputs: ["connectionString", "endpoint"],
        secretVersion: null,
        repos: null,
        branchPattern: null,
      },
      other,
    );
    await push(org, "main", [
      {
        file: ".infrawrench/ci/deploy.yml",
        name: "Deploy",
        concurrency: null,
        jobs: [{ key: "deploy", resources: { "prod-db": ["connectionString"] } }],
      },
    ]);
    const [lend] = (
      await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.organizationId, orgId))
    ).filter((a) => a.action === "ci.lend");
    expect(lend?.userId).toBe(other);
  });

  it("stops lending a member's keys when they leave, and refuses a key whose owner is gone", async () => {
    const { db, schema, eq, access } = m;
    const org = await organization({ optedIn: true });
    const { orgId, userId } = org;
    const sent = async () => {
      proxy.calls = [];
      await push(org, "main", [
        {
          file: ".infrawrench/ci/deploy.yml",
          name: "Deploy",
          concurrency: null,
          jobs: [{ key: "deploy", "ssh-keys": ["deploy"] }],
        },
      ]);
      return (proxy.calls.find((c) => c.path === "/v1/runs")?.body?.["lent"] ?? {}) as {
        "ssh-keys": Record<string, { refused?: string; files?: unknown[] }>;
      };
    };
    expect((await sent())["ssh-keys"]["deploy"]?.files).toHaveLength(2);
    // The owner leaves without the lending row being removed (defence in depth).
    await db
      .delete(schema.organizationMembers)
      .where(eq(schema.organizationMembers.userId, userId));
    expect((await sent())["ssh-keys"]["deploy"]?.refused).toBe(
      "SSH key `deploy` belongs to someone who is no longer a member",
    );
    // And the removal itself stops lending their keys.
    expect(await access.stopLendingKeysOf(orgId, userId)).toEqual(["deploy"]);
    expect((await sent())["ssh-keys"]["deploy"]?.refused).toBe(
      "SSH key `deploy` is not lent to CI",
    );
  });

  it("retries a claim the proxy was too busy for, then reports the job failed", async () => {
    const { db, schema, eq, cloud } = m;
    const org = await organization({ optedIn: true });
    const runId = await push(org, "main", [
      {
        file: ".infrawrench/ci/build.yml",
        name: "Build",
        concurrency: null,
        jobs: [{ key: "image", cloud: { provider: "aws", kind: "vm" } }],
      },
    ]);
    proxy.cloudJobs = [
      {
        run: "x",
        job: "image",
        name: "image",
        pipeline: ".infrawrench/ci/build.yml",
        state: "external",
        cloud: { provider: "aws", kind: "vm" },
        commit: { repo: "https://github.com/acme/web", sha: "a", branch: "main", ref: "r" },
        clone: { depth: 1, into: "/app" },
        cwd: "/app",
        script: "make",
        timeout_secs: 600,
        inputs: null,
        artifacts: null,
      },
    ];
    const row = async () =>
      (await db.select().from(schema.ciCloudJobs).where(eq(schema.ciCloudJobs.runId, runId)))[0];
    const due = async () =>
      db
        .update(schema.ciCloudJobs)
        .set({ nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(schema.ciCloudJobs.runId, runId));

    // A busy proxy: the job waits as `claiming`, neither started nor stranded.
    proxy.claimFailures = 1;
    proxy.calls = [];
    await cloud.runCiCloudPass();
    expect(await row()).toMatchObject({ state: "claiming", claimAttempts: 1 });
    // The next try claims and starts it.
    await due();
    await cloud.runCiCloudPass();
    expect((await row())?.state).toBe("starting");
    await db.delete(schema.ciCloudJobs).where(eq(schema.ciCloudJobs.runId, runId));

    // A proxy that stays busy: after the last try the job is reported failed.
    proxy.claimFailures = 100;
    proxy.calls = [];
    await cloud.runCiCloudPass();
    for (let i = 1; i < cloud.MAX_CLAIM_ATTEMPTS; i++) {
      await due();
      await cloud.runCiCloudPass();
    }
    expect(await row()).toMatchObject({ state: "done", outcome: "error" });
    const finish = proxy.calls.find((c) => c.path.endsWith("/jobs/image/finish"));
    expect(finish?.body?.["status"]).toBe("error");
    expect(String(finish?.body?.["error"])).toContain("could not claim the job");
  });

  /** A managed cluster and a managed database on the org's AWS connection. */
  async function managed(org: TestOrg): Promise<{ clusterId: string; dbId: string }> {
    const { db, schema } = m;
    const clusterId = `${org.awsId}:eks-cluster:prod`;
    const dbId = `${org.awsId}:rds-instance:orders`;
    await db.insert(schema.resources).values([
      {
        id: clusterId,
        organizationId: org.orgId,
        pluginId: "aws",
        resourceTypeId: "eks-cluster",
        accountId: org.awsId,
        displayName: "prod",
      },
      {
        id: dbId,
        organizationId: org.orgId,
        pluginId: "aws",
        resourceTypeId: "rds-instance",
        accountId: org.awsId,
        displayName: "orders",
        fieldsJson: { engine: "postgres" },
      },
    ] as Array<typeof schema.resources.$inferInsert>);
    return { clusterId, dbId };
  }

  const peerGrant = (
    resourceId: string,
    ciName: string,
    pluginId: string,
    extra: { jobKinds?: Array<"cluster">; branchPattern?: string | null } = {},
  ) => ({
    resourceId,
    ciName,
    outputs: [],
    secretVersion: null,
    repos: ["acme/web"],
    branchPattern: extra.branchPattern === undefined ? "main" : extra.branchPattern,
    peer: { pluginId, jobKinds: extra.jobKinds ?? [], maxConcurrentJobs: 1, maxJobMinutes: 60 },
  });

  it("offers and grants a resource as its peer, only a peer it has", async () => {
    const { access } = m;
    const org = await organization({ optedIn: false });
    const { clusterId, dbId } = await managed(org);
    expect((await access.resourceOutputs(org.orgId, clusterId)).peers).toMatchObject([
      { pluginId: "kubernetes", executor: { kinds: [{ kind: "cluster" }] } },
    ]);
    expect((await access.resourceOutputs(org.orgId, dbId)).peers).toMatchObject([
      { pluginId: "postgres", executor: null },
    ]);
    // The database without its engine set is no PostgreSQL.
    expect((await access.resourceOutputs(org.orgId, org.resourceId)).peers).toEqual([]);

    const grant = await access.createGrant(
      org.orgId,
      peerGrant(clusterId, "eks-prod", "kubernetes"),
      org.userId,
    );
    expect(grant.outputs).toEqual([]);
    expect(grant.peer).toMatchObject({ pluginId: "kubernetes", pluginName: "Kubernetes" });
    await expect(
      access.createGrant(org.orgId, peerGrant(dbId, "orders", "kubernetes"), org.userId),
    ).rejects.toThrow("cannot be lent to CI as `kubernetes`");
    // A name a connection already has would mean two things in `connections:`.
    await expect(
      access.createGrant(org.orgId, peerGrant(dbId, "Production", "postgres"), org.userId),
    ).rejects.toThrow("A connection is already called Production");
    // An update that leaves `peer` out keeps it.
    const { peer: _peer, ...withoutPeer } = peerGrant(clusterId, "eks-prod", "kubernetes");
    const kept = await access.updateGrant(org.orgId, grant.id, withoutPeer, org.userId);
    expect(kept.peer?.pluginId).toBe("kubernetes");
    const dropped = await access.updateGrant(
      org.orgId,
      grant.id,
      { ...withoutPeer, peer: null, outputs: ["kubeconfig"] },
      org.userId,
    );
    expect(dropped.peer).toBeNull();
  });

  it("lends a managed cluster and a managed database as their peers would be lent", async () => {
    const { db, schema, eq, access } = m;
    const org = await organization({ optedIn: true });
    const { clusterId, dbId } = await managed(org);
    await access.createGrant(org.orgId, peerGrant(clusterId, "eks-prod", "kubernetes"), org.userId);
    await access.createGrant(org.orgId, peerGrant(dbId, "orders", "postgres"), org.userId);
    peers.asked = [];
    proxy.calls = [];
    await push(org, "main", [
      {
        file: ".infrawrench/ci/deploy.yml",
        name: "Deploy",
        concurrency: null,
        jobs: [
          {
            key: "deploy",
            connections: [{ name: "eks-prod", namespace: "web" }, { name: "orders" }],
          },
        ],
      },
    ]);
    const sent = proxy.calls.find((c) => c.path === "/v1/runs")?.body ?? {};
    expect(sent["lent"]).toEqual({
      connections: {
        "eks-prod": {
          env: { KUBECONFIG: [{ text: "/root/.kube/eks-prod.yaml" }] },
          files: [
            {
              path: "/root/.kube/eks-prod.yaml",
              content: [{ text: "namespace: web\ntoken: " }, { secret: "peer-token-for-tests" }],
            },
          ],
        },
        orders: { env: { DATABASE_URL: "postgres://user:pw@db.example.test/app" } },
      },
    });
    // Resolved through the resource's peer, on the account that holds it.
    expect(peers.asked).toEqual(
      expect.arrayContaining([
        { pluginId: "kubernetes", accountId: org.awsId, resourceId: clusterId },
        { pluginId: "postgres", accountId: org.awsId, resourceId: dbId },
      ]),
    );
    const lends = (
      await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.organizationId, org.orgId))
    ).filter((a) => a.action === "ci.lend");
    expect(lends.map((a) => a.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "peer",
          name: "eks-prod",
          lent: "prod as Kubernetes: the kubeconfig's token",
        }),
        expect.objectContaining({ kind: "peer", name: "orders" }),
      ]),
    );
    expect(
      lends
        .filter((a) => (a.metadata as { kind: string }).kind === "peer")
        .map((a) => a.entityType),
    ).toEqual(["ci_resource_grant", "ci_resource_grant"]);
    expect(JSON.stringify(lends)).not.toContain("peer-token-for-tests");
  });

  it("lends a peer only where its grant holds, never to a fork, never under a clashing name", async () => {
    const { db, schema, eq, and, access, runs } = m;
    const org = await organization({ optedIn: true });
    const { clusterId } = await managed(org);
    await access.createGrant(org.orgId, peerGrant(clusterId, "eks-prod", "kubernetes"), org.userId);
    const deploy = [
      {
        file: ".infrawrench/ci/deploy.yml",
        name: "Deploy",
        concurrency: null,
        jobs: [{ key: "deploy", connections: [{ name: "eks-prod" }] }],
      },
    ];

    // Another branch: refused, by name.
    proxy.calls = [];
    await push(org, "feature/x", deploy);
    expect(proxy.calls.find((c) => c.path === "/v1/runs")?.body?.["lent"]).toEqual({
      connections: {
        "eks-prod": { refused: "resource `eks-prod` is not lent to CI for acme/web on feature/x" },
      },
    });

    // A fork's pull request, even approved: nothing lent, and no peer built.
    proxy.pipelines = deploy;
    peers.asked = [];
    const fork = await runs.acceptCiEvent({
      kind: "pull_request",
      installationId: org.installationId,
      repoFullName: "acme/web",
      number: 7,
      headSha: (++sha).toString(16).padStart(40, "0"),
      headRef: "main",
      headRepoFullName: "mallory/web",
      baseSha: "0".repeat(40),
      defaultBranch: "main",
      actorLogin: "mallory",
      fromFork: true,
    });
    await runs.approveRun(org.orgId, fork!.id, org.userId);
    await db
      .update(schema.ciRuns)
      .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.ciRuns.id, fork!.id));
    proxy.calls = [];
    await runs.dispatchRun(fork!.id);
    const forkRun = proxy.calls.find((c) => c.path === "/v1/runs")?.body ?? {};
    expect(forkRun["lent"]).toBeUndefined();
    expect(forkRun["trusted"]).toBeUndefined();
    expect(peers.asked).toEqual([]);

    // A connection renamed to the grant's name since: refused rather than guessed.
    await db
      .update(schema.accounts)
      .set({ displayName: "eks-prod" })
      .where(and(eq(schema.accounts.id, org.k8sId), eq(schema.accounts.organizationId, org.orgId)));
    proxy.calls = [];
    await push(org, "main", deploy);
    expect(proxy.calls.find((c) => c.path === "/v1/runs")?.body?.["lent"]).toEqual({
      connections: {
        "eks-prod": {
          refused:
            "a connection and a resource granted as one are both called `eks-prod`; rename one so a pipeline can tell them apart",
        },
      },
    });
  });

  it("runs a cloud job on a cluster granted as its peer, through the peer", async () => {
    const { db, schema, eq, access, cloud } = m;
    const org = await organization({ optedIn: true });
    const { clusterId } = await managed(org);
    // A kind is checked through the peer before it may run jobs.
    peers.preflightOk = false;
    await expect(
      access.createGrant(
        org.orgId,
        peerGrant(clusterId, "eks-prod", "kubernetes", { jobKinds: ["cluster"] }),
        org.userId,
      ),
    ).rejects.toThrow("create jobs.batch (start jobs)");
    peers.preflightOk = true;
    const grant = await access.createGrant(
      org.orgId,
      peerGrant(clusterId, "eks-prod", "kubernetes", { jobKinds: ["cluster"] }),
      org.userId,
    );
    expect(grant.peer?.preflight["cluster"]?.ok).toBe(true);

    const runId = await push(org, "main", [
      {
        file: ".infrawrench/ci/deploy.yml",
        name: "Deploy",
        concurrency: null,
        jobs: [
          {
            key: "migrate",
            cloud: { provider: "kubernetes", kind: "cluster", connection: "eks-prod" },
          },
        ],
      },
    ]);
    proxy.cloudJobs = [
      {
        run: "x",
        job: "migrate",
        name: "migrate",
        pipeline: ".infrawrench/ci/deploy.yml",
        state: "external",
        cloud: { provider: "kubernetes", kind: "cluster", connection: "eks-prod" },
        commit: {
          repo: "https://github.com/acme/web",
          sha: "a",
          branch: "main",
          ref: "refs/heads/main",
        },
        clone: { depth: 1, into: "/app" },
        cwd: "/app",
        script: "make migrate",
        timeout_secs: 600,
        inputs: null,
        artifacts: null,
      },
    ];
    await cloud.runCiCloudPass();
    const [job] = await db
      .select()
      .from(schema.ciCloudJobs)
      .where(eq(schema.ciCloudJobs.runId, runId));
    expect(job).toMatchObject({
      state: "starting",
      accountId: org.awsId,
      peerResourceId: clusterId,
      pluginId: "kubernetes",
    });
    expect(plugins.started.at(-1)).toMatchObject({ via: "kubernetes", kind: "cluster" });
    const claim = proxy.calls.find((c) => c.path.endsWith("/jobs/migrate/claim"));
    expect(String(claim?.body?.["executor"])).toBe("Kubernetes cluster on eks-prod");

    // Ending it tears the job down through the same peer.
    const token = /IWCI_TOKEN='([0-9a-f]{64})'/.exec(
      String(plugins.started.at(-1)!["bootstrap"]),
    )![1]!;
    const script = await cloud.cloudJobScript(token);
    const session = /IWCI_H='X-Infrawrench-Ci-Job: ([0-9a-f]{64})'/.exec(script)![1]!;
    await cloud.cloudJobFinish(session, {
      status: "passed",
      exitCode: 0,
      timedOut: false,
      body: "",
    });
    proxy.cloudJobs = [];
    await cloud.runCiCloudPass();
    expect(plugins.tornDown).toContain("peer:default/iwci-job");
  });
});
