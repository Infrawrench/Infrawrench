/**
 * Terraform runs against a real Postgres: what a pull request and a push
 * record, what is sent to Infrawrench CI and what is not, who may approve an
 * apply, what a posted plan leaves on the run, the commit and the pull
 * request, and what linking a state to the inventory shows on both sides.
 *
 * Only the last step to the runners is stood in for: `dispatchRun` is a
 * spy, so nothing leaves the process. Everything before it (the CI run's
 * row, its generated pipeline, the job token and the linked accounts a
 * dispatch would add) is the real code.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyGitJobToken } from "@infrawrench/client-core";
import { summarizePlan } from "@infrawrench/git-terraform";
import {
  accounts,
  ciRuns,
  costDaily,
  gitCommitStatuses,
  gitIssues,
  gitPullRequests,
  gitRepositories,
  gitTerraformRuns,
  gitTerraformWorkspaces,
  resources,
} from "@infrawrench/server-core/db/schema";
import { dispatchRun } from "@infrawrench/server-core/ci/runs";
import {
  FORK_REASON,
  recordTerraformPlan,
  reportTerraformCheck,
  terraformDispatch,
} from "@infrawrench/server-core/ci/terraform";
import { replaceManagedResources } from "@infrawrench/server-core/git-terraform/link";
import { managedByForResource } from "@infrawrench/server-core/git-terraform/managed";
import { getIacResourceStatus } from "@infrawrench/server-core/iac/service";
import { db, newId } from "../../db/client";
import type { GitPushEvent } from "../../env";
import { handlePush } from "../../events/consumer";
import { queuePullRequestPlans } from "../../events/terraform";
import { type Person, type World, configured, makeWorld } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));
// The one step that would reach the runners. Server-core's own import of
// `./runs.js` resolves to this module too.
vi.mock("@infrawrench/server-core/ci/runs", async (original) => ({
  ...(await original<typeof import("@infrawrench/server-core/ci/runs")>()),
  dispatchRun: vi.fn(async () => {}),
  // What the runners' store would answer: a job that printed something.
  getRun: vi.fn(async () => ({
    jobs: [
      {
        pipeline: "Terraform plan: prod",
        id: "plan",
        name: "Plan prod",
        status: "passed",
        reason: null,
        durationMs: 1200,
        stdout: `  + name = "${PRINTED}"\n`,
        stderr: `Warning: ${PRINTED}\n`,
      },
    ],
  })),
  openRunLogs: vi.fn(async () => new ReadableStream<Uint8Array>({ start: (c) => c.close() })),
}));

const ZERO = "0".repeat(40);
// An attribute value Terraform printed: not marked sensitive, and still not for every reader.
const PRINTED = "db-primary.internal.example";
// Obviously fake, and in no real key format.
const JOB_TOKEN_KEY = "test-job-token-key-0123456789abcdef-0123456789abcdef";

/** `terraform show -json` of a plan that adds one server and resizes another. */
const PLAN = {
  format_version: "1.2",
  terraform_version: "1.15.8",
  resource_changes: [
    {
      address: "cloud_server.web",
      mode: "managed",
      type: "cloud_server",
      name: "web",
      provider_name: "registry.terraform.io/acme/cloud",
      change: {
        actions: ["create"],
        before: null,
        after: { size: "small", admin_password: "not-a-real-password" },
        after_unknown: { id: true },
        before_sensitive: false,
        after_sensitive: { admin_password: true },
      },
    },
    {
      address: "cloud_server.api",
      mode: "managed",
      type: "cloud_server",
      name: "api",
      provider_name: "registry.terraform.io/acme/cloud",
      change: {
        actions: ["update"],
        before: { size: "small" },
        after: { size: "large" },
        after_unknown: {},
        before_sensitive: {},
        after_sensitive: {},
      },
    },
  ],
};

describe.skipIf(!configured)("Terraform runs, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person;
  let organization: { id: string; slug: string };
  let repo: string;
  let repositoryId: string;
  let accountId: string;
  let workspaceId: string;
  const previousKey = process.env["GIT_JOB_TOKEN_KEY"];

  beforeAll(async () => {
    process.env["GIT_JOB_TOKEN_KEY"] = JOB_TOKEN_KEY;
    world = makeWorld();
    [alice, bob] = (await Promise.all(["alice", "bob"].map((name) => world.person(name)))) as [
      Person,
      Person,
    ];
    organization = await world.organization("acme", { paid: true, members: [[alice, "owner"]] });
    const made = await world.repository(alice, organization.slug, "infra");
    repo = made.path;
    repositoryId = made.id;
    // Bob may push, and nothing more: no admin, and no place in the organisation.
    await world.call("PUT", `${repo}/collaborators/${bob.username}`, {
      as: alice,
      body: { role: "write" },
    });
    accountId = newId();
    await db.insert(accounts).values({
      id: accountId,
      organizationId: organization.id,
      pluginId: "hetzner",
      displayName: "Cloud production",
      encryptedCredentials: "not-read-here",
      credentialsIv: "not-read-here",
    });
  });
  afterAll(async () => {
    if (previousKey === undefined) delete process.env["GIT_JOB_TOKEN_KEY"];
    else process.env["GIT_JOB_TOKEN_KEY"] = previousKey;
    await world?.cleanup();
  });
  beforeEach(() => vi.mocked(dispatchRun).mockClear());

  const push = async (branch: string, by: Person = alice) => {
    const storage = world.storage.repository(repositoryId);
    const oldOid = storage.branches.get(branch) ?? ZERO;
    const newOid = world.storage.nextOid();
    world.storage.commits.set(newOid, { message: "A change", email: by.email });
    storage.branches.set(branch, newOid);
    world.storage.ranges.set(newOid, [newOid]);
    const event: GitPushEvent = {
      type: "push",
      repoId: repositoryId,
      actor: { kind: "user", userId: by.id, credentialId: null },
      updates: [{ name: `refs/heads/${branch}`, oldOid, newOid, forced: false }],
      at: Date.now(),
    };
    // A queue delivers at least once.
    await handlePush(event, world.env, world.storage.readers);
    await handlePush(event, world.env, world.storage.readers);
    return newOid;
  };
  const runs = async (query = "", as: Person | undefined = alice) =>
    (await world.call("GET", `${repo}/terraform/runs?limit=100${query}`, { as })).body
      .items as Array<Record<string, any>>;
  const statusOf = async (sha: string) => {
    const [row] = await db
      .select()
      .from(gitCommitStatuses)
      .where(
        and(
          eq(gitCommitStatuses.repositoryId, repositoryId),
          eq(gitCommitStatuses.sha, sha),
          eq(gitCommitStatuses.context, "Infrawrench Terraform / prod"),
        ),
      );
    return row ?? null;
  };
  const ciRunOf = async (terraformRunId: string) => {
    const rows = await db.select().from(ciRuns).where(eq(ciRuns.terraformRunId, terraformRunId));
    return rows;
  };

  it("lists the organisation's accounts for the picker, to those who may see them", async () => {
    const listed = await world.call("GET", `${repo}/terraform/accounts`, { as: alice });
    expect(listed.body.accounts).toEqual([
      { accountId, name: "Cloud production", pluginId: "hetzner", pluginName: "hetzner" },
    ]);
    // Not an admin of the repository.
    expect((await world.call("GET", `${repo}/terraform/accounts`, { as: bob })).status).toBe(403);
    // A personal namespace has no organisation to list.
    const own = await world.repository(alice, alice.username, "scratch");
    expect((await world.call("GET", `${own.path}/terraform/accounts`, { as: alice })).body).toEqual(
      { accounts: [] },
    );
    // And gets the state backend only: nothing is planned, and a run cannot be asked for.
    await world.call("POST", `${own.path}/terraform/workspaces`, {
      as: alice,
      body: { name: "prod", rootPath: "" },
    });
    expect(
      await world.call("POST", `${own.path}/terraform/workspaces/prod/runs`, {
        as: alice,
        body: { operation: "plan" },
      }),
    ).toMatchObject({ status: 422, body: { code: "terraform_unavailable" } });
    expect(
      (await world.call("GET", `${own.path}/terraform/runs`, { as: alice })).body.items,
    ).toEqual([]);
  });

  it("plans a pull request as a CI run with a generated pipeline and no secret in it", async () => {
    const created = await world.call("POST", `${repo}/terraform/workspaces`, {
      as: alice,
      body: { name: "prod", rootPath: "infra", accountIds: [accountId] },
    });
    expect(created.body).toMatchObject({
      name: "prod",
      applyOnMerge: true,
      applyRequiresApproval: true,
      accounts: [{ accountId, name: "Cloud production" }],
    });
    workspaceId = created.body.id;

    await push("feature", bob);
    const pull = (
      await world.call("POST", `${repo}/pulls`, {
        as: bob,
        body: { title: "More servers", base: "main", head: "feature" },
      })
    ).body;

    const [plan] = await runs(`&pull=${pull.number}`);
    expect(plan).toMatchObject({
      operation: "plan",
      trigger: "pull_request",
      status: "queued",
      commitOid: pull.headOid,
      pullNumber: pull.number,
    });
    const rows = await ciRunOf(plan!["id"]);
    expect(rows).toHaveLength(1);
    const ci = rows[0]!;
    expect(plan!["ciRunId"]).toBe(ci.id);
    expect(ci).toMatchObject({
      organizationId: organization.id,
      gitRepositoryId: repositoryId,
      event: "pull-request",
      pullNumber: pull.number,
      sha: pull.headOid,
      fromFork: false,
      status: "queued",
    });
    expect(vi.mocked(dispatchRun)).toHaveBeenCalledWith(ci.id);
    // The pipeline is the workspace's, lends its linked account by name, and
    // only ever names the job token.
    const text = ci.pipelineText!;
    expect(text).toContain(`/${organization.slug}/infra/terraform/prod/state`);
    expect(text).toContain(`/terraform/prod/runs/${plan!["id"]}/plan`);
    expect(text).toContain("Cloud production");
    expect(text).toContain("secrets.IW_GIT_JOB_TOKEN");
    expect(text).not.toMatch(/iwj_|not-read-here/);
    expect(await statusOf(pull.headOid)).toMatchObject({ state: "pending", description: "Queued" });

    // What a dispatch adds: a job token for this run and this repository, and the linked account.
    const dispatch = await terraformDispatch(ci);
    if ("refuse" in dispatch) throw new Error(dispatch.refuse);
    const token = dispatch.secrets["IW_GIT_JOB_TOKEN"]!;
    // Bound to the run's workspace, and a plan's: it reads the state and never writes it.
    expect(
      await verifyGitJobToken(JOB_TOKEN_KEY, token, { repositoryId, workspace: workspaceId }),
    ).toMatchObject({
      ok: true,
      claims: { runId: ci.id, repositoryId, access: "read", workspace: workspaceId },
    });
    // Nothing that serves the repository itself takes it: not a clone, not a push.
    for (const expected of [{ repositoryId }, { repositoryId, access: "write" as const }]) {
      expect(await verifyGitJobToken(JOB_TOKEN_KEY, token, expected)).toEqual({
        ok: false,
        reason: "access",
      });
    }
    expect([...dispatch.linkedAccounts.keys()]).toEqual([accountId]);
    expect(dispatch.linkedAccounts.get(accountId)).toBe(alice.id);
    // Never stored: not on the CI run, not on the Terraform run.
    expect(JSON.stringify(await ciRunOf(plan!["id"]))).not.toContain(token);

    // The fork rule is asked again where the credentials are handed over: a
    // run whose pull request's head is not this repository's is not sent.
    const [held] = await db
      .select({ issueId: gitPullRequests.issueId })
      .from(gitPullRequests)
      .innerJoin(gitIssues, eq(gitIssues.id, gitPullRequests.issueId))
      .where(and(eq(gitIssues.repositoryId, repositoryId), eq(gitIssues.number, pull.number)));
    await db
      .update(gitPullRequests)
      .set({ headRepositoryId: null })
      .where(eq(gitPullRequests.issueId, held!.issueId));
    expect(await terraformDispatch(ci)).toEqual({ refuse: FORK_REASON });
    await db
      .update(gitPullRequests)
      .set({ headRepositoryId: repositoryId })
      .where(eq(gitPullRequests.issueId, held!.issueId));
    expect(await terraformDispatch(ci)).toHaveProperty("secrets");

    // A second delivery of the pull request's head records nothing new.
    await queuePullRequestPlans({
      repositoryId,
      organizationId: organization.id,
      defaultBranch: "main",
      baseRef: "main",
      headRef: "feature",
      headOid: pull.headOid,
      pullNumber: pull.number,
      userId: bob.id,
      fromFork: false,
    });
    expect(await runs(`&pull=${pull.number}`)).toHaveLength(1);
  });

  it("stores a posted plan as its summary, on the run, the commit and the pull request", async () => {
    const pull = (await world.call("GET", `${repo}/pulls?state=open`, { as: alice })).body.items[0];
    const [plan] = await runs(`&pull=${pull.number}`);
    const ciRunId = plan!["ciRunId"] as string;
    const summary = summarizePlan(PLAN);

    // Another run's job cannot post this run's plan.
    expect(
      await recordTerraformPlan({ runId: plan!["id"], ciRunId: "another-ci-run", summary }),
    ).toBeNull();
    // The runners say it started, then its job posts the plan.
    await reportTerraformCheck(
      { id: ciRunId, terraformRunId: plan!["id"] },
      { status: "in_progress", title: "Running", summary: "" },
    );
    expect((await runs(`&pull=${pull.number}`))[0]).toMatchObject({ status: "planning" });
    expect(await recordTerraformPlan({ runId: plan!["id"], ciRunId, summary })).not.toBeNull();

    const [planned] = await runs(`&pull=${pull.number}`);
    expect(planned).toMatchObject({
      status: "planned",
      plan: { add: 1, change: 1, destroy: 0, hasChanges: true },
    });
    expect(planned!["plan"].resourceChanges).toEqual([
      expect.objectContaining({ address: "cloud_server.web", action: "create" }),
      expect.objectContaining({
        address: "cloud_server.api",
        action: "update",
        changedAttributes: ["size"],
      }),
    ]);
    // Names, never values.
    const [stored] = await db
      .select()
      .from(gitTerraformRuns)
      .where(eq(gitTerraformRuns.id, plan!["id"]));
    expect(stored).toMatchObject({
      resourcesToAdd: 1,
      resourcesToChange: 1,
      resourcesToDestroy: 0,
      costPricedAt: null,
    });
    expect(JSON.stringify(stored)).not.toContain("not-a-real-password");
    expect(await statusOf(pull.headOid)).toMatchObject({
      state: "success",
      description: "Plan: 1 to add, 1 to change, 0 to destroy.",
    });
    const timeline = (
      await world.call("GET", `${repo}/issues/${pull.number}/timeline?limit=100`, { as: alice })
    ).body.items as Array<Record<string, any>>;
    expect(timeline.filter((item) => item["type"] === "terraform_run")).toEqual([
      expect.objectContaining({
        runId: plan!["id"],
        workspace: "prod",
        operation: "plan",
        outcome: "planned",
        add: 1,
        change: 1,
        destroy: 0,
      }),
    ]);
    // The job ending changes nothing about a plan that is in, and writes no second entry.
    await reportTerraformCheck(
      { id: ciRunId, terraformRunId: plan!["id"] },
      { status: "completed", conclusion: "success", title: "1 job passed", summary: "" },
    );
    expect((await runs(`&pull=${pull.number}`))[0]).toMatchObject({ status: "planned" });
    expect(await statusOf(pull.headOid)).toMatchObject({ state: "success" });
  });

  it("never plans a fork's pull request: skipped with the reason, nothing sent", async () => {
    const headOid = world.storage.nextOid();
    await queuePullRequestPlans({
      repositoryId,
      organizationId: organization.id,
      defaultBranch: "main",
      baseRef: "main",
      headRef: "fix",
      headOid,
      pullNumber: 4040,
      userId: bob.id,
      fromFork: true,
    });
    const [skipped] = await runs("&pull=4040");
    expect(skipped).toMatchObject({
      status: "skipped",
      statusReason: FORK_REASON,
      ciRunId: null,
      plan: null,
    });
    expect((await runs("&status=skipped")).map((run) => run["id"])).toEqual([skipped!["id"]]);
    expect(await ciRunOf(skipped!["id"])).toEqual([]);
    expect(vi.mocked(dispatchRun)).not.toHaveBeenCalled();
    // Not a failure, and not a pass: the commit gets no status that says a plan ran.
    expect(await statusOf(headOid)).toBeNull();
    // Even asked directly, a skipped run is never sent.
    expect(
      await terraformDispatch({
        id: "a-ci-run",
        terraformRunId: skipped!["id"],
        gitRepositoryId: repositoryId,
      }),
    ).toEqual({ refuse: expect.stringMatching(/skipped/) });
  });

  it("holds an apply until someone who may approves it", async () => {
    const landed = await push("main");
    const applies = (await runs()).filter((run) => run["operation"] === "apply");
    expect(applies).toHaveLength(1);
    const apply = applies[0]!;
    expect(apply).toMatchObject({
      status: "awaiting_approval",
      trigger: "merge",
      commitOid: landed,
      ciRunId: null,
      viewerCanApprove: true,
    });
    // The gate is the dispatch: nothing was sent, and nothing can be.
    expect(await ciRunOf(apply["id"])).toEqual([]);
    expect(vi.mocked(dispatchRun)).not.toHaveBeenCalled();
    expect(
      await terraformDispatch({
        id: "a-ci-run",
        terraformRunId: apply["id"],
        gitRepositoryId: repositoryId,
      }),
    ).toEqual({ refuse: expect.stringMatching(/approval/) });
    expect(await statusOf(landed)).toMatchObject({ state: "pending" });

    // Bob can push, but is no admin and has no `ci:approve`.
    const bobs = (await runs("", bob)).find((run) => run["id"] === apply["id"]);
    expect(bobs).toMatchObject({ viewerCanApprove: false });
    const approve = (who: Person) =>
      world.call("POST", `${repo}/terraform/runs/${apply["id"]}/approve`, { as: who });
    expect((await approve(bob)).status).toBe(403);
    expect(await ciRunOf(apply["id"])).toEqual([]);

    const approved = await approve(alice);
    expect(approved.body).toMatchObject({ status: "queued", approvedBy: { id: alice.id } });
    const [ci] = await ciRunOf(apply["id"]);
    expect(ci).toMatchObject({ event: "push", branch: "main", sha: landed, status: "queued" });
    expect(ci!.pipelineText).toContain("Terraform apply: prod");
    expect(vi.mocked(dispatchRun)).toHaveBeenCalledWith(ci!.id);
    // Two approvals make one run.
    expect((await approve(alice)).status).toBe(409);
    expect(await ciRunOf(apply["id"])).toHaveLength(1);

    // It plans again at the merge commit, posts that plan, and applies it.
    expect(
      await recordTerraformPlan({
        runId: apply["id"],
        ciRunId: ci!.id,
        summary: summarizePlan(PLAN),
      }),
    ).toMatchObject({ status: "running", resourcesToAdd: 1 });
    await reportTerraformCheck(
      { id: ci!.id, terraformRunId: apply["id"] },
      { status: "completed", conclusion: "success", title: "1 job passed", summary: "" },
    );
    expect((await runs()).find((run) => run["id"] === apply["id"])).toMatchObject({
      status: "applied",
      plan: { add: 1, change: 1 },
    });
    expect(await statusOf(landed)).toMatchObject({
      state: "success",
      description: "Applied: 1 added, 1 changed, 0 destroyed.",
    });

    // A newer push replaces an apply nobody approved.
    const first = await push("main");
    const second = await push("main");
    const waiting = (await runs()).filter((run) => run["operation"] === "apply");
    expect(waiting.find((run) => run["commitOid"] === first)).toMatchObject({
      status: "discarded",
    });
    expect(waiting.find((run) => run["commitOid"] === second)).toMatchObject({
      status: "awaiting_approval",
    });
  });

  it("applies at once only for a workspace that asks for no approval", async () => {
    await world.call("PATCH", `${repo}/terraform/workspaces/prod`, {
      as: alice,
      body: { applyRequiresApproval: false },
    });
    const landed = await push("main");
    const apply = (await runs()).find(
      (run) => run["operation"] === "apply" && run["commitOid"] === landed,
    );
    expect(apply).toMatchObject({ status: "queued" });
    expect(await ciRunOf(apply!["id"])).toHaveLength(1);
    // With apply-on-merge off it waits again, whatever the other switch says.
    await world.call("PATCH", `${repo}/terraform/workspaces/prod`, {
      as: alice,
      body: { applyOnMerge: false },
    });
    const next = await push("main");
    expect(
      (await runs()).find((run) => run["operation"] === "apply" && run["commitOid"] === next),
    ).toMatchObject({ status: "awaiting_approval" });
    // Started by hand by someone who may approve, an apply needs no second approval.
    const manual = await world.call("POST", `${repo}/terraform/workspaces/prod/runs`, {
      as: alice,
      body: { operation: "apply" },
    });
    expect(manual.body).toMatchObject({
      operation: "apply",
      trigger: "manual",
      status: "queued",
      approvedBy: { id: alice.id },
    });
    expect((await ciRunOf(manual.body.id))[0]).toMatchObject({ event: "manual" });
    // By someone who may not, it waits for one.
    const bobs = await world.call("POST", `${repo}/terraform/workspaces/prod/runs`, {
      as: bob,
      body: { operation: "apply" },
    });
    expect(bobs.body).toMatchObject({ status: "awaiting_approval", approvedBy: null });
    expect(await ciRunOf(bobs.body.id)).toEqual([]);
    // A plan of a branch starts at once, for anyone who may write.
    const plan = await world.call("POST", `${repo}/terraform/workspaces/prod/runs`, {
      as: bob,
      body: { operation: "plan", ref: "feature" },
    });
    expect(plan.body).toMatchObject({ operation: "plan", status: "queued", ref: "feature" });
  });

  it("shows what a workspace manages on both sides, and its cost only to who may see it", async () => {
    const resourceId = `${accountId}:server:srv-1`;
    await db.insert(resources).values({
      id: resourceId,
      organizationId: organization.id,
      accountId,
      pluginId: "hetzner",
      resourceTypeId: "server",
      displayName: "web-1",
      externalId: "srv-1",
    } as typeof resources.$inferInsert);
    await replaceManagedResources(
      { id: workspaceId, organizationId: organization.id },
      null,
      [
        {
          address: "hcloud_server.web",
          terraformType: "hcloud_server",
          provider: "registry.terraform.io/hetznercloud/hcloud",
          label: "web-1",
          resourceId,
          matchedBy: "external-id",
        },
        {
          address: "hcloud_volume.data",
          terraformType: "hcloud_volume",
          provider: "registry.terraform.io/hetznercloud/hcloud",
          label: "data",
          resourceId: null,
          matchedBy: null,
        },
      ],
      true,
    );
    const [linked] = await db
      .select()
      .from(gitTerraformWorkspaces)
      .where(eq(gitTerraformWorkspaces.id, workspaceId));
    expect(linked!.linkedAt).not.toBeNull();

    // The app's resource page: which repository and root manage it. The
    // repository is public, so anyone who may see the resource is told.
    const managedBy = await managedByForResource(organization.id, resourceId);
    expect(managedBy).toEqual([
      {
        repository: `${organization.slug}/infra`,
        rootPath: "infra",
        workspace: "prod",
        address: "hcloud_server.web",
        url: `https://git.infrawrench.com/${organization.slug}/infra/terraform/prod`,
      },
    ]);
    // On the endpoint the page reads, beside a badge that needs no uploaded state.
    expect(await getIacResourceStatus(organization.id, resourceId)).toEqual({
      status: null,
      stateId: null,
      stateLabel: null,
      terraformAddress: null,
      driftFieldCount: 0,
      managedBy,
    });
    // A private repository is named only to someone who reads the organisation's repositories.
    await db
      .update(gitRepositories)
      .set({ visibility: "private" })
      .where(eq(gitRepositories.id, repositoryId));
    expect(await managedByForResource(organization.id, resourceId)).toEqual([]);
    expect((await getIacResourceStatus(organization.id, resourceId)).managedBy).toEqual([]);
    expect(await managedByForResource(organization.id, resourceId, { readsGit: true })).toEqual(
      managedBy,
    );
    expect(
      (await getIacResourceStatus(organization.id, resourceId, { readsGit: true })).managedBy,
    ).toEqual(managedBy);
    await db
      .update(gitRepositories)
      .set({ visibility: "public" })
      .where(eq(gitRepositories.id, repositoryId));
    // Another organisation asking about the same id learns nothing.
    expect(await managedByForResource("another-organization", resourceId)).toEqual([]);
    expect((await getIacResourceStatus(organization.id, "no-such-resource")).managedBy).toEqual([]);

    // Spend on the resource over the last month, as the app collected it.
    const yesterday = new Date(Date.now() - 24 * 60 * 60_000).toISOString().slice(0, 10);
    await db.insert(costDaily).values({
      organization_id: organization.id,
      account_id: accountId,
      plugin_id: "hetzner",
      day: yesterday,
      service: "Servers",
      region: "fsn1",
      resource_id: "srv-1",
      tags: {},
      tags_hash: "",
      currency: "EUR",
      amount: 12.5,
      usage_amount: 0,
      usage_unit: "",
    } as typeof costDaily.$inferInsert);

    // The forge's Infrastructure tab, for the organisation's owner.
    const listed = await world.call("GET", `${repo}/terraform/workspaces/prod/resources`, {
      as: alice,
    });
    expect(listed.body.items).toEqual([
      expect.objectContaining({
        address: "hcloud_server.web",
        type: "hcloud_server",
        infrawrench: expect.objectContaining({ resourceId, name: "web-1", pluginId: "hetzner" }),
        monthlyCost: { amount: 12.5, currency: "EUR" },
      }),
      expect.objectContaining({
        address: "hcloud_volume.data",
        infrawrench: null,
        monthlyCost: null,
      }),
    ]);
    const workspace = await world.call("GET", `${repo}/terraform/workspaces/prod`, { as: alice });
    expect(workspace.body).toMatchObject({
      monthlyCost: { amount: 12.5, currency: "EUR" },
      matchedResourceCount: 1,
    });

    // What only an administrator gets: a state's document. Bob writes the
    // repository, as every member of an organisation does, and a visitor reads it.
    const download = `${repo}/terraform/workspaces/prod/state-versions/no-such-version/download`;
    expect((await world.call("GET", download, { as: bob })).status).toBe(403);
    expect((await world.call("GET", download)).status).toBe(401);
    // Alice administers it: past the gate, there is simply no such version.
    expect((await world.call("GET", download, { as: alice })).status).toBe(404);

    // A workspace run's output: Terraform prints values that are not marked
    // sensitive, so it takes `write`. The run and its jobs stay visible.
    const [terraformCi] = await db
      .select({ id: ciRuns.id })
      .from(ciRuns)
      .where(and(eq(ciRuns.gitRepositoryId, repositoryId), isNotNull(ciRuns.terraformRunId)))
      .limit(1);
    const runPath = `${repo}/ci/runs/${terraformCi!.id}`;
    const visitor = await world.call("GET", runPath);
    expect(visitor.status).toBe(200);
    expect(visitor.body.jobs).toEqual([
      expect.objectContaining({ id: "plan", status: "passed", stdout: "", stderr: "" }),
    ]);
    expect(JSON.stringify(visitor.body)).not.toContain(PRINTED);
    expect((await world.call("GET", `${runPath}/log`)).status).toBe(403);
    const writer = await world.call("GET", runPath, { as: bob });
    expect(writer.body.jobs[0].stdout).toContain(PRINTED);
    expect((await world.call("GET", `${runPath}/log`, { as: bob })).status).toBe(200);

    // Bob can read the repository and is nobody in the organisation: no money.
    const bobs = await world.call("GET", `${repo}/terraform/workspaces/prod/resources`, {
      as: bob,
    });
    expect(bobs.body.items.map((item: Record<string, unknown>) => item["monthlyCost"])).toEqual([
      null,
      null,
    ]);
    expect(
      (await world.call("GET", `${repo}/terraform/workspaces/prod`, { as: bob })).body,
    ).toMatchObject({ monthlyCost: null, matchedResourceCount: 1 });
    // Neither does a visitor of the public repository.
    expect((await world.call("GET", `${repo}/terraform/workspaces/prod`)).body).toMatchObject({
      monthlyCost: null,
    });
  });
});
