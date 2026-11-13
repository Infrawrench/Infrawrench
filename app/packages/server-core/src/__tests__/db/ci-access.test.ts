/**
 * CI access against a real Postgres: what a run is lent at dispatch (its
 * opt-ins, refusals and audit rows), and a cloud job's whole life (claim,
 * start, the machine's callback relayed to the runner, teardown, and the
 * reaper). The CI proxy, GitHub and the plugins are fakes: no provider is
 * ever called.
 *
 * Skipped unless DATABASE_URL is set, migrations applied, scratch databases
 * only: it writes an organization and its rows, and deletes them after.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

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
};

/** What the fake plugins were asked. */
const plugins = {
  started: [] as Array<Record<string, unknown>>,
  tornDown: [] as string[],
  tagged: [] as Array<Record<string, unknown>>,
};

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
        plugin: {
          manifest: {
            displayName: "Kubernetes",
            ciCredential: { description: "x", shortLived: false },
            credentialFields: [{ key: "kubeconfig", label: "k", sensitive: true }],
          },
        },
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
      plugin: {
        manifest: {
          displayName: "Amazon Web Services",
          credentialFields: [],
          ciExecutor: {
            kinds: [{ kind: "vm", label: "EC2 instance", defaults: { machine: "t3.large" } }],
          },
        },
      },
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

vi.mock("../../peer-clients.js", () => ({
  getClientForResource: async () => ({
    client: {
      resolveOutput: async (_type: string, _id: string, key: string) =>
        key === "connectionString" ? "postgres://user:pw@db.example.test/app" : "",
    },
  }),
}));

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

const orgId = `test-org-${randomUUID()}`;
const userId = `test-user-${randomUUID()}`;
const installationId = 910_000_000 + Math.floor(Math.random() * 1_000_000);
const k8sId = `acc-k8s-${randomUUID()}`;
const awsId = `acc-aws-${randomUUID()}`;
const resourceId = `${awsId}:rds-instance:prod`;
let sha = 0;

describe.skipIf(!configured)("CI access against a real Postgres", () => {
  async function modules() {
    const { db } = await import("../../db/client");
    const schema = await import("../../db/schema");
    const runs = await import("../../ci/runs");
    const access = await import("../../ci/access");
    const cloud = await import("../../ci/cloud-jobs");
    const { encrypt, buildAad } = await import("../../encryption");
    const { eq } = await import("drizzle-orm");
    return { db, schema, runs, access, cloud, encrypt, buildAad, eq };
  }

  async function push(branch: string, pipelines: unknown[]): Promise<string> {
    const { runs, db, schema, eq } = await modules();
    proxy.pipelines = pipelines;
    const accepted = await runs.acceptCiEvent({
      kind: "push",
      installationId,
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

  afterAll(async () => {
    if (!configured) return;
    const { db, schema, eq } = await modules();
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.organizationId, orgId));
    await db.delete(schema.ciRuns).where(eq(schema.ciRuns.organizationId, orgId));
    await db.delete(schema.ciAccounts).where(eq(schema.ciAccounts.organizationId, orgId));
    await db
      .delete(schema.githubInstallations)
      .where(eq(schema.githubInstallations.organizationId, orgId));
    await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.$client.end();
  });

  it("sets up an organization with connections, a resource and an SSH key", async () => {
    const { db, schema, encrypt, buildAad } = await modules();
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
      [k8sId, "kubernetes", "Production cluster"],
      [awsId, "aws", "Production"],
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
      id: resourceId,
      organizationId: orgId,
      pluginId: "aws",
      resourceTypeId: "rds-instance",
      accountId: awsId,
      displayName: "prod-db",
    } as typeof schema.resources.$inferInsert);
    const keyId = randomUUID();
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
  });

  it("opts in only what passes its checks", async () => {
    const { access } = await modules();
    const settings = {
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
    // Not yet checked: refused.
    await expect(access.setConnectionAccess(orgId, awsId, settings, userId)).rejects.toThrow(
      "Check the connection's permissions",
    );
    const checked = await access.preflightConnection(orgId, awsId, "vm", undefined);
    expect(checked.preflight["vm"]?.ok).toBe(true);
    const saved = await access.setConnectionAccess(orgId, awsId, settings, userId);
    expect(saved.settings.jobsEnabled).toBe(true);
    // AWS lends nothing.
    await expect(
      access.setConnectionAccess(orgId, awsId, { ...settings, lendEnabled: true }, userId),
    ).rejects.toThrow("cannot be lent");

    const lent = await access.setConnectionAccess(
      orgId,
      k8sId,
      {
        ...settings,
        jobsEnabled: false,
        jobKinds: [],
        lendEnabled: true,
        lendBranchPattern: "main",
      },
      userId,
    );
    expect(lent.settings.lendEnabled).toBe(true);

    const grant = await access.createGrant(
      orgId,
      {
        resourceId,
        ciName: "prod-db",
        outputs: ["connectionString"],
        secretVersion: null,
        repos: ["acme/web"],
        branchPattern: null,
      },
      userId,
    );
    expect(grant.ciName).toBe("prod-db");
    await expect(
      access.createGrant(
        orgId,
        { ...grant, outputs: ["connectionString"], resourceId, secretVersion: null },
        userId,
      ),
    ).rejects.toThrow("already called prod-db");

    const overview = await access.ciAccessOverview(orgId, userId);
    const key = await (async () => {
      const { db, schema, eq } = await modules();
      const [k] = await db.select().from(schema.sshKeys).where(eq(schema.sshKeys.userId, userId));
      return k!;
    })();
    expect(overview.sshKeys).toEqual([]);
    await expect(
      access.setSshKeyLending(orgId, "someone-else", key.id, {
        enabled: true,
        ciName: "deploy",
        repos: null,
        branchPattern: null,
      }),
    ).rejects.toThrow("No such SSH key of yours");
    const lending = await access.setSshKeyLending(orgId, userId, key.id, {
      enabled: true,
      ciName: "deploy",
      repos: null,
      branchPattern: null,
    });
    expect(lending).toMatchObject({ ciName: "deploy", mine: true });
  });

  it("lends a trusted run what its jobs name, refusing the rest by name", async () => {
    const { db, schema, eq } = await modules();
    proxy.calls = [];
    const id = await push("main", [
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
      .where(eq(schema.auditLogs.organizationId, orgId));
    const lends = audits.filter((a) => a.action === "ci.lend");
    expect(lends.map((a) => (a.metadata as { name: string }).name).sort()).toEqual([
      "Production cluster",
      "deploy",
      "prod-db",
    ]);
    expect(lends.every((a) => a.userId === userId)).toBe(true);
    // Nothing secret in the audit log.
    expect(JSON.stringify(lends)).not.toContain("minted-token-for-tests");
  });

  it("refuses a branch outside the permission", async () => {
    proxy.calls = [];
    await push("feature/x", [
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

  it("runs a cloud job from claim to teardown, and reaps what nothing owns", async () => {
    const { db, schema, eq, cloud } = await modules();
    const runId = await push("main", [
      {
        file: ".infrawrench/ci/build.yml",
        name: "Build",
        concurrency: null,
        jobs: [{ key: "image", cloud: { provider: "aws", kind: "vm" } }],
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
    expect(job).toMatchObject({ state: "starting", jobId: "image", accountId: awsId });
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
    await expect(cloud.cloudJobScript(token)).rejects.toThrow("already fetched");

    proxy.calls = [];
    await cloud.cloudJobLog(token, "stdout", "building\n");
    expect(proxy.calls[0]).toEqual({
      path: `/v1/runs/${encodeURIComponent(job!.proxyRunId)}/jobs/image/log`,
      body: { claim: "c".repeat(32), stream: "stdout", text: "building\n" },
    });
    await cloud.cloudJobFinish(token, {
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
    await expect(cloud.cloudJobLog(token, "stdout", "late\n")).rejects.toThrow("ended");

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
    const { cloud } = await modules();
    await push("main", [
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
    proxy.calls = [];
    await push("main", [
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
    const { db, schema, eq } = await modules();
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.organizationId, orgId));
    proxy.runFailures = 1;
    await push("main", [
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
      .where(eq(schema.auditLogs.organizationId, orgId));
    expect(audits.filter((a) => a.action === "ci.lend")).toHaveLength(1);
  });

  it("names whoever last widened a grant as who allowed a read of it", async () => {
    const { db, schema, eq, access } = await modules();
    const other = `test-user-${randomUUID()}`;
    await db.insert(schema.users).values({ id: other, email: `${other}@example.test` });
    const [grant] = await db
      .select()
      .from(schema.ciResourceGrants)
      .where(eq(schema.ciResourceGrants.organizationId, orgId));
    await access.updateGrant(
      orgId,
      grant!.id,
      {
        resourceId,
        ciName: "prod-db",
        outputs: ["connectionString", "endpoint"],
        secretVersion: null,
        repos: null,
        branchPattern: null,
      },
      other,
    );
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.organizationId, orgId));
    await push("main", [
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
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, other));
    await db.update(schema.ciResourceGrants).set({ updatedByUserId: null, createdByUserId: null });
    await db.delete(schema.users).where(eq(schema.users.id, other));
  });

  it("stops lending a member's keys when they leave, and refuses a key whose owner is gone", async () => {
    const { db, schema, eq, access } = await modules();
    const sent = async () => {
      proxy.calls = [];
      await push("main", [
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
    await db
      .insert(schema.organizationMembers)
      .values({ id: randomUUID(), userId, organizationId: orgId, role: "admin" });
  });

  it("retries a claim the proxy was too busy for, then reports the job failed", async () => {
    const { db, schema, eq, cloud } = await modules();
    // Earlier runs are over: only this one's job is waiting.
    await db
      .update(schema.ciRuns)
      .set({ status: "passed" })
      .where(eq(schema.ciRuns.organizationId, orgId));
    const runId = await push("main", [
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
    proxy.claimFailures = 0;
    proxy.cloudJobs = [];
  });
});
