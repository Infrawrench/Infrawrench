/**
 * A person's own namespace on git.infrawrench.com connected to an
 * organization, against a real Postgres: who may connect it, that its
 * repositories' runs are the organization's (plan, bill, CI tab) under the
 * person's own owner key, that nothing is sent as the organization's once
 * the person has left it, and the poller's storage-price reconcile. The CI
 * proxy and Stripe are fakes that record what they were asked.
 *
 * Skipped unless DATABASE_URL is set, migrations applied, scratch databases
 * only: it writes organizations and their runs, and deletes them after.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configured = !!process.env["DATABASE_URL"];

interface Call {
  path: string;
  body: Record<string, unknown> | null;
}

const fake = {
  proxy: [] as Call[],
  concurrency: new Map<string, Record<string, unknown>>(),
  next: 0,
  paid: new Set<string>(),
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const parse = (init: RequestInit = {}) =>
  init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;

vi.mock("../../entitlements.js", () => ({
  planAccess: async (organizationId: string) => ({ paid: fake.paid.has(organizationId) }),
}));
vi.mock("../../github/app.js", () => ({
  getInstallationToken: async () => "installation-token-for-tests",
  githubInstallationFetch: async () => json(201, { id: 1 }),
}));
vi.mock("../../ci/proxy.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../ci/proxy.js")>();
  const proxyFetch = async (path: string, init: RequestInit = {}) => {
    const body = parse(init);
    fake.proxy.push({ path, body });
    if (path === "/v1/concurrency") {
      return json(200, fake.concurrency.get(String(body?.["sha"])) ?? { pipelines: [] });
    }
    if (path === "/v1/runs") {
      const id = `ci-1.${(++fake.next).toString(16).padStart(32, "0")}`;
      return json(202, { id, state: "running" });
    }
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

const run = randomUUID().slice(0, 8);
const acme = `test-org-acme-${run}`;
const other = `test-org-other-${run}`;
const mara = `test-user-mara-${run}`;
const stranger = `test-user-stranger-${run}`;
const username = `mara-${run}`;
const namespaceId = randomUUID();
const repositoryId = randomUUID();
const orgNamespaceId = randomUUID();
const repository = {
  id: repositoryId,
  namespace: username,
  name: "dotfiles",
  defaultBranch: "main",
  // As the forge's Worker names a person's repository: no organization.
  organizationId: null,
};
const TEST_PIPELINE = { file: ".infrawrench/ci/test.yml", name: "Test", concurrency: null };

describe.skipIf(!configured)("a person's namespace connected to an organization", () => {
  let sha = 0;
  const nextCommit = () => (++sha).toString(16).padStart(40, "0");

  async function modules() {
    const { db } = await import("../../db/client");
    const schema = await import("../../db/schema");
    const runs = await import("../../ci/runs");
    const events = await import("../../ci/git-events");
    const workspace = await import("../../git/workspace");
    const status = await import("../../ci/status");
    const orm = await import("drizzle-orm");
    return { db, schema, runs, events, workspace, status, orm };
  }

  const push = async (branch = "main") => {
    const { events } = await modules();
    const commit = nextCommit();
    fake.concurrency.set(commit, { commit, pipelines: [TEST_PIPELINE], invalid: [] });
    return events.acceptGitEvent({
      kind: "push",
      repository,
      ref: `refs/heads/${branch}`,
      before: null,
      after: commit,
      forced: false,
      pusher: username,
    });
  };

  async function row(id: string) {
    const { db, schema, orm } = await modules();
    const [r] = await db.select().from(schema.ciRuns).where(orm.eq(schema.ciRuns.id, id));
    if (!r) throw new Error(`no run ${id}`);
    return r;
  }

  /** Makes a run due by this process's clock too, then sends it. */
  async function dispatch(id: string) {
    const { db, schema, runs, orm } = await modules();
    await db
      .update(schema.ciRuns)
      .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where(orm.eq(schema.ciRuns.id, id));
    await runs.dispatchRun(id);
  }

  const sentRuns = () => fake.proxy.filter((c) => c.path === "/v1/runs");

  async function membership(organizationId: string, member: boolean) {
    const { db, schema, orm } = await modules();
    await db
      .delete(schema.organizationMembers)
      .where(
        orm.and(
          orm.eq(schema.organizationMembers.userId, mara),
          orm.eq(schema.organizationMembers.organizationId, organizationId),
        ),
      );
    if (member) {
      await db
        .insert(schema.organizationMembers)
        .values({ id: randomUUID(), userId: mara, organizationId, role: "member" });
    }
  }

  beforeEach(async () => {
    fake.proxy = [];
    fake.paid = new Set([acme, other]);
    process.env["GIT_JOB_TOKEN_KEY"] = "k".repeat(48);
    process.env["APP_URL"] = "https://app.example.test";
    if (configured) {
      const { status } = await modules();
      status.setGitStatusWriter(async () => {});
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["STRIPE_SECRET_KEY"];
    delete process.env["STRIPE_GIT_STORAGE_PRICE_ID"];
  });

  afterAll(async () => {
    if (!configured) return;
    const { db, schema, orm } = await modules();
    for (const id of [acme, other]) {
      await db.delete(schema.ciRuns).where(orm.eq(schema.ciRuns.organizationId, id));
      await db.delete(schema.ciSchedules).where(orm.eq(schema.ciSchedules.organizationId, id));
    }
    await db
      .delete(schema.gitNamespaces)
      .where(orm.inArray(schema.gitNamespaces.id, [namespaceId, orgNamespaceId]));
    await db
      .delete(schema.organizations)
      .where(orm.inArray(schema.organizations.id, [acme, other]));
    await db.delete(schema.users).where(orm.inArray(schema.users.id, [mara, stranger]));
    await db.$client.end();
  });

  it("sets up a person with a repository of their own, in one of two organizations", async () => {
    const { db, schema } = await modules();
    await db.insert(schema.users).values([
      { id: mara, email: `${mara}@example.test` },
      { id: stranger, email: `${stranger}@example.test` },
    ]);
    await db.insert(schema.organizations).values([
      { id: acme, displayName: "Acme" },
      { id: other, displayName: "Other" },
    ]);
    await membership(acme, true);
    await db.insert(schema.gitNamespaces).values({
      id: namespaceId,
      slug: username,
      slugLower: username,
      kind: "user",
      userId: mara,
    });
    await db.insert(schema.gitRepositories).values({
      id: repositoryId,
      namespaceId,
      name: repository.name,
      nameLower: repository.name,
    });
  });

  it("runs nothing until the namespace is connected", async () => {
    const { workspace } = await modules();
    expect(await workspace.gitCiHome(repositoryId)).toBeNull();
    expect(await push()).toBeNull();
  });

  it("is connected only by its owner, only to an organization they belong to", async () => {
    const { workspace } = await modules();
    expect(await workspace.setGitWorkspace(mara, other)).toEqual({
      ok: false,
      reason: "not_member",
    });
    expect(await workspace.setGitWorkspace(mara, "no-such-organization")).toEqual({
      ok: false,
      reason: "not_member",
    });
    // Someone with no namespace has nothing to connect, whoever they name.
    expect(await workspace.setGitWorkspace(stranger, acme)).toEqual({
      ok: false,
      reason: "no_namespace",
    });
    expect(await workspace.gitWorkspaceOf(mara)).toBeNull();

    expect(await workspace.setGitWorkspace(mara, acme)).toEqual({ ok: true, organizationId: acme });
    expect(await workspace.gitWorkspaceOf(mara)).toBe(acme);
    expect(await workspace.gitCiHome(repositoryId)).toEqual({
      organizationId: acme,
      personal: true,
    });
  });

  it("refuses the connection on an organization's namespace, in the database itself", async () => {
    const { db, schema } = await modules();
    await expect(
      db.insert(schema.gitNamespaces).values({
        id: orgNamespaceId,
        slug: `acme-${run}`,
        slugLower: `acme-${run}`,
        kind: "org",
        organizationId: acme,
        workspaceOrganizationId: other,
      }),
    ).rejects.toThrow();
  });

  it("records a push as the organization's run and sends it under the person's own owner", async () => {
    const accepted = await push();
    expect(accepted?.status).toBe("queued");
    await dispatch(accepted!.id);
    const r = await row(accepted!.id);
    expect(r).toMatchObject({
      status: "running",
      // Billed, gated and listed as the organization's.
      organizationId: acme,
      gitRepositoryId: repositoryId,
      repoFullName: `${username}/dotfiles`,
      ownerKey: `git.infrawrench.com-${username}`,
    });
    const [sent] = sentRuns();
    // The proxy keeps secrets and variables per owner: the person's
    // namespace, which no secret of the organization's is stored under.
    expect(sent?.body).toMatchObject({
      repo: `https://git.infrawrench.com/${username}/dotfiles.git`,
      owner: `git.infrawrench.com-${username}`,
      "repo-id": "dotfiles",
    });
    expect(sent?.body).not.toHaveProperty("lent");
    expect(sent?.body).not.toHaveProperty("secrets");

    // The CI tab lists it under the organization, and nowhere else.
    const { runs } = await modules();
    const listed = await runs.listRuns(acme, { limit: 50, includeHidden: true });
    expect(listed.map((x) => x.id)).toContain(accepted!.id);
    expect(await runs.listRuns(other, { limit: 50, includeHidden: true })).toEqual([]);
  });

  it("is not lent what the organization lends to every repository, only what names it", async () => {
    const { db, schema, orm } = await modules();
    const accountId = randomUUID();
    await db.insert(schema.accounts).values({
      id: accountId,
      organizationId: acme,
      pluginId: "kubernetes",
      displayName: "Production cluster",
      encryptedCredentials: "unused",
      credentialsIv: "unused",
    } as typeof schema.accounts.$inferInsert);
    // Lent to CI for every repository and every branch of the organization's.
    await db.insert(schema.ciConnectionAccess).values({
      id: randomUUID(),
      organizationId: acme,
      accountId,
      lendEnabled: true,
      lendRepos: null,
      lendBranchPattern: null,
    } as typeof schema.ciConnectionAccess.$inferInsert);

    const deploy = async (branch: string) => {
      const { events } = await modules();
      const commit = nextCommit();
      fake.concurrency.set(commit, {
        commit,
        pipelines: [
          {
            file: ".infrawrench/ci/deploy.yml",
            name: "Deploy",
            concurrency: null,
            jobs: [{ key: "deploy", connections: [{ name: "Production cluster" }] }],
          },
        ],
        invalid: [],
      });
      const accepted = await events.acceptGitEvent({
        kind: "push",
        repository,
        ref: `refs/heads/${branch}`,
        before: null,
        after: commit,
        forced: false,
        pusher: username,
      });
      fake.proxy = [];
      await dispatch(accepted!.id);
      return sentRuns()[0]?.body?.["lent"] as
        { connections?: Record<string, { refused?: string }> } | undefined;
    };

    // The person decides what their own branches hold, so "every repository"
    // is not theirs: the job that names the connection fails with the reason.
    const lent = await deploy("deploy");
    expect(lent?.connections?.["Production cluster"]).toEqual({
      refused: `connection \`Production cluster\` is lent to the organization's own repositories; a person's repository is lent it by name (git.infrawrench.com/${username}/dotfiles)`,
    });

    // Named by an administrator of the organization, the scope no longer
    // refuses it (what stops this fake connection is that it has no cluster).
    await db
      .update(schema.ciConnectionAccess)
      .set({ lendRepos: [`git.infrawrench.com/${username}/dotfiles`] })
      .where(orm.eq(schema.ciConnectionAccess.accountId, accountId));
    const named = await deploy("deploy-named");
    expect(named?.connections?.["Production cluster"]?.refused).not.toMatch(
      /own repositories|not lent to CI for/,
    );
    await db.delete(schema.accounts).where(orm.eq(schema.accounts.id, accountId));
  });

  it("needs the organization's paid plan, as its own repositories do", async () => {
    fake.paid = new Set([other]);
    expect(await push("unpaid")).toBeNull();
    fake.paid = new Set([acme, other]);
    const accepted = await push("lapsed");
    fake.paid = new Set([other]);
    await dispatch(accepted!.id);
    expect(await row(accepted!.id)).toMatchObject({
      status: "error",
      statusReason: "CI needs a paid plan.",
    });
    expect(sentRuns()).toEqual([]);
  });

  it("sends nothing as the organization's once the person has left it", async () => {
    const { runs, workspace, db, schema, orm } = await modules();
    const queued = await push("before-leaving");
    expect(queued?.status).toBe("queued");
    await membership(acme, false);

    // Nothing was written: the stored connection is simply no longer one.
    expect(await workspace.gitWorkspaceOf(mara)).toBeNull();
    expect(await workspace.gitCiHome(repositoryId)).toBeNull();
    expect(await push("after-leaving")).toBeNull();
    // A run queued while they were a member is not sent either.
    await dispatch(queued!.id);
    expect(await row(queued!.id)).toMatchObject({
      status: "error",
      statusReason: runs.GIT_HOME_MOVED,
    });
    expect(sentRuns()).toEqual([]);

    // The sweep clears the column and takes the repository out of the CI tab.
    expect(await workspace.sweepGitWorkspaces()).toBeGreaterThanOrEqual(1);
    const [namespace] = await db
      .select({ workspace: schema.gitNamespaces.workspaceOrganizationId })
      .from(schema.gitNamespaces)
      .where(orm.eq(schema.gitNamespaces.id, namespaceId));
    expect(namespace?.workspace).toBeNull();
    expect(
      await db
        .select()
        .from(schema.ciGitRepositories)
        .where(orm.eq(schema.ciGitRepositories.gitRepositoryId, repositoryId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.ciSchedules)
        .where(orm.eq(schema.ciSchedules.gitRepositoryId, repositoryId)),
    ).toEqual([]);
  });

  it("moves to another organization without the first one paying for anything more", async () => {
    const { runs, workspace } = await modules();
    await membership(acme, true);
    await membership(other, true);
    expect((await workspace.setGitWorkspace(mara, acme)).ok).toBe(true);
    const queued = await push("for-acme");
    expect((await row(queued!.id)).organizationId).toBe(acme);

    expect(await workspace.setGitWorkspace(mara, other)).toEqual({
      ok: true,
      organizationId: other,
    });
    await dispatch(queued!.id);
    expect(await row(queued!.id)).toMatchObject({
      status: "error",
      statusReason: runs.GIT_HOME_MOVED,
    });
    expect(sentRuns()).toEqual([]);

    const next = await push("for-other");
    expect((await row(next!.id)).organizationId).toBe(other);
    await dispatch(next!.id);
    expect(sentRuns()).toHaveLength(1);

    expect(await workspace.setGitWorkspace(mara, null)).toEqual({ ok: true, organizationId: null });
    expect(await push("for-nobody")).toBeNull();
  });

  describe("the storage price on older subscriptions", () => {
    const PRICE = "price_test_git_storage";
    const stripe: Array<{ method: string; url: string; body: string | null; key: string | null }> =
      [];
    let items: Array<{ price: { id: string } }> = [];
    let failing = false;

    const stubStripe = () => {
      stripe.length = 0;
      vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        const method = init.method ?? "GET";
        const headers = new Headers(init.headers);
        stripe.push({
          method,
          url,
          body: init.body ? String(init.body) : null,
          key: headers.get("Idempotency-Key"),
        });
        if (failing) return json(500, { error: { message: "down" } });
        if (method === "POST") {
          items.push({ price: { id: PRICE } });
          return json(200, { id: "si_new" });
        }
        return json(200, { object: "list", data: items });
      });
    };

    const ensuredAt = async () => {
      const { db, schema, orm } = await modules();
      const [namespace] = await db
        .select({ at: schema.gitNamespaces.storagePriceEnsuredAt })
        .from(schema.gitNamespaces)
        .where(orm.eq(schema.gitNamespaces.id, orgNamespaceId));
      return namespace?.at ?? null;
    };

    it("is added once to a subscription that lacks it, for an organization with a namespace", async () => {
      const { db, schema } = await modules();
      const billing = await import("../../git/billing");
      await db.insert(schema.gitNamespaces).values({
        id: orgNamespaceId,
        slug: `acme-${run}`,
        slugLower: `acme-${run}`,
        kind: "org",
        organizationId: acme,
      });
      const subscription = `sub_test_${run}`;
      await db.insert(schema.subscriptions).values({
        id: randomUUID(),
        organizationId: acme,
        stripeCustomerId: `cus_test_${run}`,
        stripeSubscriptionId: subscription,
        status: "active",
      });
      items = [{ price: { id: "price_test_seat" } }];
      stubStripe();
      const mine = () =>
        stripe.filter(
          (call) => call.url.includes(subscription) || call.body?.includes(subscription),
        );

      // Not configured: nothing is asked and nothing is marked.
      expect(await billing.ensureGitStoragePrices()).toBe(0);
      expect(stripe).toEqual([]);

      process.env["STRIPE_SECRET_KEY"] = "sk_test_not_a_real_key";
      process.env["STRIPE_GIT_STORAGE_PRICE_ID"] = PRICE;
      billing.resetGitStoragePriceRetries();

      // Stripe is away: nothing is marked, and it is not asked again at once.
      failing = true;
      await billing.ensureGitStoragePrices(1000);
      expect(await ensuredAt()).toBeNull();
      const asked = mine().length;
      expect(asked).toBe(1);
      await billing.ensureGitStoragePrices(1000);
      expect(mine()).toHaveLength(asked);

      failing = false;
      billing.resetGitStoragePriceRetries();
      stripe.length = 0;
      await billing.ensureGitStoragePrices(1000);
      expect(mine().map((call) => call.method)).toEqual(["GET", "POST"]);
      const post = mine()[1]!;
      expect(post.url).toBe("https://api.stripe.com/v1/subscription_items");
      expect(new URLSearchParams(post.body ?? "").get("price")).toBe(PRICE);
      expect(new URLSearchParams(post.body ?? "").get("subscription")).toBe(subscription);
      expect(post.key).toBe(`git-storage-price-${subscription}-${PRICE}`);
      expect(await ensuredAt()).not.toBeNull();

      // Looked at once: the next pass asks Stripe nothing about it.
      stripe.length = 0;
      await billing.ensureGitStoragePrices(1000);
      expect(mine()).toEqual([]);
    });

    it("only marks a subscription that already carries the price", async () => {
      const { db, schema, orm } = await modules();
      const billing = await import("../../git/billing");
      await db
        .update(schema.gitNamespaces)
        .set({ storagePriceEnsuredAt: null })
        .where(orm.eq(schema.gitNamespaces.id, orgNamespaceId));
      process.env["STRIPE_SECRET_KEY"] = "sk_test_not_a_real_key";
      process.env["STRIPE_GIT_STORAGE_PRICE_ID"] = PRICE;
      billing.resetGitStoragePriceRetries();
      items = [{ price: { id: "price_test_seat" } }, { price: { id: PRICE } }];
      stubStripe();
      await billing.ensureGitStoragePrices(1000);
      expect(stripe.filter((call) => call.method === "POST")).toEqual([]);
      expect(await ensuredAt()).not.toBeNull();
    });
  });
});
