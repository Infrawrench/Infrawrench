/**
 * A managed cluster lent to a CI job as its Kubernetes peer, end to end on
 * the app's side: a grant made through `ci/access`, a push dispatched
 * through `ci/runs`, and `ci/lend` resolving the peer exactly as the peer
 * tabs do (the real `getClientForResource`, credential rewriters and the
 * real `kubernetes` plugin's `lendCiCredential`) from the cluster's
 * `kubeconfig` output. Only the cloud connection that holds the cluster is a
 * fake: it answers that output as GKE's does, a kubeconfig with an inline
 * token, and the CI proxy, which records the run request.
 *
 * With `IWCI_PEER_LENT_OUT` set, the run request's `lent` is written to that
 * file, which is the `IWCI_LENT_FILE` a runner reads (`ci-runner/README.md`):
 * the other half of the test runs a job with it against a fake API server
 * (`builtins/kubectl/fake-apiserver.go`, which wants `fixture-token` on
 * 127.0.0.1:6443), with `kubectl` from `builtin:kubectl`.
 *
 * Skipped unless DATABASE_URL is set, migrations applied, scratch databases
 * only: it writes an organization and its rows, and deletes them after.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const configured = !!process.env["DATABASE_URL"];
process.env["ENCRYPTION_MASTER_KEY"] ??= randomBytes(32).toString("base64");
process.env["APP_URL"] ??= "https://app.example.test";
process.env["CI_PROXY_URL"] ??= "https://ci-proxy.example.test";

const sent = vi.hoisted(() => ({
  runs: [] as Array<Record<string, unknown>>,
  pipelines: [] as unknown[],
}));

/** What GKE's `kubeconfig` output is: one context, the API server, an inline token. */
const GKE_KUBECONFIG = [
  "apiVersion: v1",
  "kind: Config",
  "clusters:",
  "- cluster:",
  "    server: https://127.0.0.1:6443",
  // The fake API server makes its certificate when it starts.
  "    insecure-skip-tls-verify: true",
  "  name: prod-cluster",
  "contexts:",
  "- context:",
  "    cluster: prod-cluster",
  "    user: prod-cluster",
  "  name: prod-cluster",
  "current-context: prod-cluster",
  "users:",
  "- name: prod-cluster",
  "  user:",
  "    token: fixture-token",
].join("\n");

vi.mock("../../plugin-loader.js", async () => {
  const { hostPlugins } = await import("@infrawrench/plugin-base/effect");
  const { plugin: kubernetes } = await import("@infrawrench/plugin-kubernetes");
  const gcp = {
    manifest: { id: "gcp", displayName: "Google Cloud", credentialFields: [] },
    resourceTypes: [
      {
        id: "gke-cluster",
        outputs: [{ key: "kubeconfig", label: "Kubeconfig", sensitive: true }],
        peerIntegrations: [
          {
            pluginId: "kubernetes",
            credentialMappings: [{ outputKey: "kubeconfig", credentialKey: "kubeconfig" }],
            tabLabel: "Kubernetes",
            ci: {
              lends: "A kubeconfig with a Google access token",
              reach: "The cluster",
              lifetime: "Up to seven hours",
              credentialMappings: [{ outputKey: "ciKubeconfig", credentialKey: "kubeconfig" }],
            },
          },
        ],
      },
    ],
  };
  const loaded = [{ plugin: gcp }, ...hostPlugins([kubernetes]).map((plugin) => ({ plugin }))];
  return {
    pluginCodeAvailable: () => true,
    loadPlugins: async () => loaded,
    getPlugin: async (id: string) => loaded.find((l) => l.plugin.manifest.id === id),
  };
});

// The cloud connection holding the cluster: its client answers the cluster's
// outputs, as the GCP plugin does.
vi.mock("../../org-accounts.js", () => ({
  getOrgAccountClient: async (accountId: string) => ({
    account: { id: accountId, pluginId: "gcp" },
    credentials: {},
    plugin: {
      manifest: { id: "gcp", displayName: "Google Cloud", credentialFields: [] },
      resourceTypes: [
        {
          id: "gke-cluster",
          peerIntegrations: [
            {
              pluginId: "kubernetes",
              credentialMappings: [{ outputKey: "kubeconfig", credentialKey: "kubeconfig" }],
              tabLabel: "Kubernetes",
              ci: {
                lends: "A kubeconfig with a Google access token",
                reach: "The cluster",
                lifetime: "Up to seven hours",
                credentialMappings: [{ outputKey: "ciKubeconfig", credentialKey: "kubeconfig" }],
              },
            },
          ],
        },
      ],
    },
    client: {
      // The GCP plugin mints the CI one's token for the run; this fake's is fixed.
      resolveOutput: async (_type: string, _id: string, key: string) =>
        key === "ciKubeconfig" ? GKE_KUBECONFIG : key === "kubeconfig" ? "not-for-ci" : "",
      getResource: async (type: string, id: string) => ({
        id,
        resourceTypeId: type,
        fields: {},
        resolvedOutputs: {},
      }),
    },
  }),
}));

vi.mock("../../features.js", () => ({ orgHasFeature: async () => true }));
vi.mock("../../entitlements.js", () => ({ planAccess: async () => ({ paid: true }) }));
vi.mock("../../github/app.js", () => ({
  getInstallationToken: async () => "installation-token-for-tests",
  githubInstallationFetch: async () => new Response("{}", { status: 201 }),
}));

vi.mock("../../ci/proxy.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../ci/proxy.js")>();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const proxyFetch = async (path: string, init: RequestInit = {}) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (path === "/v1/concurrency") return json(200, { pipelines: sent.pipelines });
    if (path === "/v1/runs") {
      sent.runs.push(body);
      return json(202, { id: `ci-1.${"0".repeat(31)}${sent.runs.length}`, state: "running" });
    }
    return json(404, { error: "not here" });
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

describe.skipIf(!configured)("a GKE cluster lent to a job as Kubernetes", () => {
  const orgId = `test-org-${randomUUID()}`;
  const userId = `test-user-${randomUUID()}`;
  const accountId = `acc-gcp-${randomUUID()}`;
  const clusterId = `${accountId}:gke-cluster:prod`;
  const installationId = 920_000_000 + Math.floor(Math.random() * 1_000_000);
  let m: {
    db: typeof import("../../db/client").db;
    schema: typeof import("../../db/schema");
    eq: typeof import("drizzle-orm").eq;
  };

  beforeAll(async () => {
    const { db } = await import("../../db/client");
    const schema = await import("../../db/schema");
    const { eq } = await import("drizzle-orm");
    m = { db, schema, eq };
    await db.insert(schema.users).values({ id: userId, email: `${userId}@example.test` });
    await db.insert(schema.organizations).values({ id: orgId, displayName: "CI peer test" });
    await db
      .insert(schema.organizationMembers)
      .values({ id: randomUUID(), userId, organizationId: orgId, role: "admin" });
    await db.insert(schema.githubInstallations).values({
      id: randomUUID(),
      organizationId: orgId,
      installationId,
      accountLogin: "acme",
    } as typeof schema.githubInstallations.$inferInsert);
    await db
      .insert(schema.ciAccounts)
      .values({ id: randomUUID(), organizationId: orgId, installationId, accountLogin: "acme" });
    await db.insert(schema.accounts).values({
      id: accountId,
      organizationId: orgId,
      pluginId: "gcp",
      displayName: "Infrawrench GCP",
      encryptedCredentials: "unused",
      credentialsIv: "unused",
    } as typeof schema.accounts.$inferInsert);
    await db.insert(schema.resources).values({
      id: clusterId,
      organizationId: orgId,
      pluginId: "gcp",
      resourceTypeId: "gke-cluster",
      accountId,
      displayName: "prod-cluster",
    } as typeof schema.resources.$inferInsert);
  });

  afterAll(async () => {
    if (!m) return;
    const { db, schema, eq } = m;
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

  it("lends the kubeconfig the Kubernetes plugin writes, its token a secret part", async () => {
    const { db, schema, eq } = m;
    const access = await import("../../ci/access");
    const runs = await import("../../ci/runs");
    const options = await access.resourceOutputs(orgId, clusterId);
    expect(options.peers?.map((p) => p.pluginId)).toEqual(["kubernetes"]);
    await access.createGrant(
      orgId,
      {
        resourceId: clusterId,
        ciName: "gke-prod",
        outputs: [],
        secretVersion: null,
        repos: ["acme/web"],
        branchPattern: "main",
        peer: {
          pluginId: "kubernetes",
          lend: true,
          jobKinds: [],
          maxConcurrentJobs: 1,
          maxJobMinutes: 60,
          jobRegions: [],
        },
      },
      userId,
    );

    sent.pipelines = [
      {
        file: ".infrawrench/ci/deploy.yml",
        name: "kubectl",
        concurrency: null,
        jobs: [{ key: "peer-passes", connections: [{ name: "gke-prod", namespace: "default" }] }],
      },
    ];
    const accepted = await runs.acceptCiEvent({
      kind: "push",
      baseSha: null,
      installationId,
      repoFullName: "acme/web",
      branch: "main",
      sha: "e".repeat(40),
      defaultBranch: "main",
      actorLogin: "octocat",
    });
    await db
      .update(schema.ciRuns)
      .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.ciRuns.id, accepted!.id));
    await runs.dispatchRun(accepted!.id);

    const lent = sent.runs.at(-1)?.["lent"] as {
      connections: Record<
        string,
        {
          env: Record<string, unknown>;
          files: Array<{ path: string; mode: string; content: unknown }>;
        }
      >;
    };
    const entry = lent.connections["gke-prod"]!;
    expect(entry.env).toEqual({ KUBECONFIG: [{ text: "/root/.kube/gke-prod.yaml" }] });
    const [file] = entry.files;
    expect(file).toMatchObject({ path: "/root/.kube/gke-prod.yaml", mode: "600" });
    const parts = file!.content as Array<{ text: string } | { secret: string }>;
    // The token is the one secret part; the rest of the file shows in a log.
    expect(parts.filter((p) => "secret" in p)).toEqual([{ secret: "fixture-token" }]);
    const text = parts.map((p) => ("text" in p ? p.text : p.secret)).join("");
    expect(text).toContain('server: "https://127.0.0.1:6443"');
    expect(text).toContain("insecure-skip-tls-verify: true");
    expect(text).toContain('namespace: "default"');
    expect(text).not.toMatch(/exec:|auth-provider:/);

    const out = process.env["IWCI_PEER_LENT_OUT"];
    if (out) writeFileSync(out, `${JSON.stringify(lent, null, 2)}\n`);
  });
});
