/**
 * A person's work across repositories against a real Postgres: the home
 * page's counts, lists, suggestions and activity, the Changes list and its
 * filters, the comments that mention them, and that none of it reaches a
 * repository the caller has no tie to.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  gitAgentLinks,
  gitBranchVersions,
  gitComments,
  gitInstructions,
  gitIssueAssignees,
  gitIssues,
  gitPullRequests,
  gitReviewFindings,
  gitReviewRuns,
  gitReviews,
} from "@infrawrench/server-core/db/schema";
import { db, newId } from "../../db/client";
import { type Person, type World, configured, makeWorld } from "./world";

const OID = (digit: string) => digit.repeat(40);
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

describe.skipIf(!configured)("a person's work across repositories, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person, carol: Person;
  let team: { id: string; slug: string };
  let app: { id: string; path: string };
  const ids: Record<string, string> = {};

  /** A pull request as its rows, with one version a push. */
  const pull = async (
    key: string,
    number: number,
    by: Person,
    fields: {
      title: string;
      body?: string;
      draft?: boolean;
      merged?: { by: Person; hours: number };
      hours: number;
      versions?: number;
    },
  ) => {
    const id = newId();
    ids[key] = id;
    const at = hoursAgo(fields.hours);
    await db.insert(gitIssues).values({
      id,
      repositoryId: app.id,
      number,
      isPullRequest: true,
      title: fields.title,
      body: fields.body ?? "",
      state: fields.merged ? "closed" : "open",
      authorUserId: by.id,
      createdAt: at,
      updatedAt: at,
    });
    await db.insert(gitPullRequests).values({
      issueId: id,
      repositoryId: app.id,
      baseRef: "main",
      headRepositoryId: app.id,
      headRef: `branch-${key}`,
      headOid: OID("a"),
      baseOid: OID("b"),
      draft: fields.draft ?? false,
      additions: 120,
      deletions: 40,
      changedFiles: 3,
      mergedAt: fields.merged ? hoursAgo(fields.merged.hours) : null,
      mergedByUserId: fields.merged?.by.id ?? null,
    });
    for (let version = 1; version <= (fields.versions ?? 1); version++) {
      await db.insert(gitBranchVersions).values({
        id: newId(),
        repositoryId: app.id,
        branch: `branch-${key}`,
        lineage: 1,
        number: version,
        tipOid: OID("a"),
        pusherUserId: by.id,
        pullRequestId: id,
        createdAt: new Date(at.getTime() + version * 1000),
      });
    }
    return id;
  };

  beforeAll(async () => {
    world = makeWorld();
    [alice, bob, carol] = (await Promise.all(
      ["alice", "bob", "carol"].map((name) => world.person(name)),
    )) as [Person, Person, Person];
    team = await world.organization("team", {
      paid: true,
      git: true,
      members: [
        [alice, "owner"],
        [bob, "member"],
      ],
    });
    app = await world.repository(alice, team.slug, "app", "private");
    await world.repository(alice, alice.username, "own", "private");

    // Alice's, approved by bob, with a comment from bob that names her.
    const a = await pull("a", 11, alice, {
      title: "Add rate limits",
      body: "## Limit requests per token\n\nWith a body.",
      hours: 5,
    });
    await db.insert(gitReviews).values({
      id: newId(),
      pullRequestId: a,
      repositoryId: app.id,
      authorUserId: bob.id,
      state: "approved",
      commitOid: OID("a"),
      submittedAt: hoursAgo(4),
    });
    await db.insert(gitComments).values([
      {
        id: newId(),
        issueId: a,
        repositoryId: app.id,
        authorUserId: bob.id,
        body: `Looks right.\nOne thing, @${alice.username}: the limit is per token, not per key.`,
        createdAt: hoursAgo(3),
      },
      // A longer name that starts with hers, and her own comment: neither is a mention of her.
      {
        id: newId(),
        issueId: a,
        repositoryId: app.id,
        authorUserId: bob.id,
        body: `@${alice.username}x might know`,
        createdAt: hoursAgo(2),
      },
      {
        id: newId(),
        issueId: a,
        repositoryId: app.id,
        authorUserId: alice.id,
        body: `Note to @${alice.username}`,
        createdAt: hoursAgo(1),
      },
    ]);

    // Bob's, two versions, alice assigned, one must-fix finding from a review run.
    const b = await pull("b", 12, bob, { title: "Cache the token lookup", hours: 2, versions: 2 });
    await db.insert(gitIssueAssignees).values({ issueId: b, userId: alice.id });
    const run = newId();
    await db.insert(gitReviewRuns).values({
      id: run,
      repositoryId: app.id,
      pullRequestId: b,
      versionNumber: 2,
      headOid: OID("a"),
      status: "done",
      finishedAt: hoursAgo(1.5),
    });
    await db.insert(gitReviewFindings).values({
      id: newId(),
      repositoryId: app.id,
      pullRequestId: b,
      runId: run,
      versionNumber: 2,
      lastSeenVersionNumber: 2,
      reviewerKind: "security",
      fingerprint: "security:cache:stale-token",
      commitOid: OID("a"),
      severity: "must_fix",
      title: "A revoked token stays cached",
    });

    // Bob's, merged by alice.
    await pull("c", 13, bob, {
      title: "Log the token id",
      hours: 30,
      merged: { by: alice, hours: 20 },
    });

    // Bob's draft, written by an agent alice connected, with an instruction out.
    const d = await pull("d", 14, bob, { title: "Rotate tokens", draft: true, hours: 8 });
    await db.insert(gitAgentLinks).values({
      pullRequestId: d,
      repositoryId: app.id,
      kind: "mcp",
      displayName: "An agent",
      connectedByUserId: alice.id,
    });
    await db.insert(gitInstructions).values({
      id: newId(),
      repositoryId: app.id,
      pullRequestId: d,
      source: "text",
      body: "Rotate weekly",
      createdByUserId: alice.id,
    });
  });
  afterAll(() => world?.cleanup());

  const home = async (as: Person | undefined, query = "") =>
    world.call("GET", `/api/workspace/home${query}`, { as });
  const changes = async (as: Person, query = "") =>
    (await world.call("GET", `/api/workspace/changes${query}`, { as })).body.items as Array<
      Record<string, any>
    >;
  const titles = (items: Array<Record<string, any>>) => items.map((item) => item["title"]);

  it("counts and lists the open branches of a workspace, the viewer's apart from the team's", async () => {
    const { status, body } = await home(alice, `?namespace=${team.slug}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      namespace: { slug: team.slug, kind: "org" },
      shared: true,
      activeBranches: 3,
      agentsWorking: 1,
      yours: { count: 2 },
      team: { count: 1 },
    });
    // The most recently active first; the agent she connected makes bob's draft hers too.
    expect(titles(body.yours.items)).toEqual(["Add rate limits", "Rotate tokens"]);
    expect(body.yours.items[0]).toMatchObject({
      state: "approved",
      summary: "Limit requests per token",
      branch: "branch-a",
      latestVersion: 1,
      author: { id: alice.id },
      agent: null,
      size: { additions: 120, deletions: 40, changedFiles: 3 },
    });
    expect(body.yours.items[1]).toMatchObject({
      state: "agent_working",
      draft: true,
      summary: null,
      agent: { kind: "mcp", displayName: "An agent" },
    });
    expect(body.team.items).toMatchObject([
      { title: "Cache the token lookup", state: "changes_requested", mustFixOpen: 1 },
    ]);
  });

  it("suggests what the viewer has a part in and has not reviewed, with why", async () => {
    const { body } = await home(alice);
    expect(body.suggested).toMatchObject({
      count: 1,
      items: [
        {
          title: "Cache the token lookup",
          latestVersion: 2,
          reviewedVersion: null,
          // The strongest first: she is assigned, and she pushes to this repository too.
          reasons: [
            { kind: "assigned", version: null },
            { kind: "pushes_to_repository", version: null },
          ],
        },
      ],
    });
    // Once she has reviewed the newest version there is nothing left to suggest.
    await world.call("PUT", `${app.path}/pulls/12/versions/latest/reviewed`, { as: alice });
    expect((await home(alice)).body.suggested).toEqual({ count: 0, items: [] });
    // Bob wrote that one, and approved alice's as it stands: neither is suggested to him.
    expect((await home(bob)).body.suggested.items).toEqual([]);
  });

  it("says where work was pushed and what happened, in the window asked for", async () => {
    const { body } = await home(alice, "?days=7");
    expect(body.pushed).toMatchObject({ days: 7, versions: 5 });
    expect(body.pushed.repositories).toMatchObject([{ id: app.id, name: "app" }]);
    const said = (body.activity as Array<Record<string, any>>).map(
      (event) => `${event["type"]} ${event["title"]}`,
    );
    expect(said).toContain("approved Add rate limits");
    expect(said).toContain("merged Log the token id");
    expect(said).toContain("findings Cache the token lookup");
    expect(said.filter((line) => line === "pushed Cache the token lookup")).toHaveLength(2);
    const found = body.activity.find((event: Record<string, any>) => event["type"] === "findings");
    expect(found).toMatchObject({ actor: null, version: 2, findings: { found: 1, mustFix: 1 } });
    const times = body.activity.map((event: Record<string, any>) => Date.parse(event["at"]));
    expect(times).toEqual([...times].sort((x: number, y: number) => y - x));

    // A day back: the merge twenty hours ago is in, the push thirty hours ago is not.
    const day = (await home(alice, "?days=1")).body;
    expect(day.pushed.versions).toBe(4);
    expect(day.activity.some((event: Record<string, any>) => event["type"] === "merged")).toBe(
      true,
    );
    expect((await home(alice, "?days=3")).status).toBe(400);
  });

  it("filters the Changes list by state and by whose it is, and pages it", async () => {
    expect(titles(await changes(alice))).toEqual([
      "Cache the token lookup",
      "Add rate limits",
      "Rotate tokens",
    ]);
    expect(titles(await changes(alice, "?state=merged"))).toEqual(["Log the token id"]);
    expect((await changes(alice, "?state=merged"))[0]).toMatchObject({ state: "merged" });
    expect(await changes(alice, "?state=all")).toHaveLength(4);
    expect(titles(await changes(alice, "?author=mine"))).toEqual([
      "Add rate limits",
      "Rotate tokens",
    ]);
    expect(titles(await changes(bob, "?author=mine"))).toEqual([
      "Cache the token lookup",
      "Rotate tokens",
    ]);
    expect(titles(await changes(alice, "?author=team&state=all"))).toEqual([
      "Cache the token lookup",
      "Log the token id",
    ]);

    const first = (await world.call("GET", "/api/workspace/changes?limit=2", { as: alice })).body;
    expect(first.items).toHaveLength(2);
    const rest = (
      await world.call("GET", `/api/workspace/changes?limit=2&cursor=${first.nextCursor}`, {
        as: alice,
      })
    ).body;
    expect(titles(rest.items)).toEqual(["Rotate tokens"]);
    expect(rest.nextCursor).toBeNull();
  });

  it("keeps a workspace to its namespace", async () => {
    const own = (await home(alice, `?namespace=${alice.username}`)).body;
    expect(own).toMatchObject({
      namespace: { slug: alice.username, kind: "user" },
      shared: false,
      activeBranches: 0,
      yours: { count: 0, items: [] },
      team: { count: 0, items: [] },
      activity: [],
    });
    expect(await changes(alice, `?namespace=${alice.username}&state=all`)).toEqual([]);
    expect(await changes(alice, `?namespace=${team.slug.toUpperCase()}&state=all`)).toHaveLength(4);
  });

  it("shows none of it to someone with no tie to the repository", async () => {
    for (const query of ["", `?namespace=${team.slug}`]) {
      const { status, body } = await home(carol, query);
      expect(status).toBe(200);
      expect(body).toMatchObject({
        activeBranches: 0,
        agentsWorking: 0,
        pushed: { versions: 0, repositories: [] },
        yours: { count: 0, items: [] },
        team: { count: 0, items: [] },
        suggested: { count: 0, items: [] },
        activity: [],
      });
    }
    expect(await changes(carol, `?namespace=${team.slug}&state=all`)).toEqual([]);
    expect((await home(undefined)).status).toBe(401);
    expect((await world.call("GET", "/api/workspace/changes")).status).toBe(401);
    expect((await world.call("GET", "/api/workspace/mentions")).status).toBe(401);
    // A token without a repository scope sees what a signed-out visitor does.
    expect(
      (await world.call("GET", "/api/workspace/home", { as: alice, scopes: [] })).body,
    ).toMatchObject({ activeBranches: 0 });
  });

  it("lists the comments by other people that name the viewer", async () => {
    const mentions = async (as: Person) =>
      (await world.call("GET", "/api/workspace/mentions", { as })).body.items as Array<
        Record<string, any>
      >;
    expect(await mentions(alice)).toMatchObject([
      {
        kind: "comment",
        repository: { id: app.id },
        number: 11,
        title: "Add rate limits",
        isPullRequest: true,
        author: { id: bob.id },
        excerpt: `One thing, @${alice.username}: the limit is per token, not per key.`,
      },
    ]);
    expect(await mentions(bob)).toEqual([]);
    // Carol cannot read the repository, whoever a comment in it names.
    await db.insert(gitComments).values({
      id: newId(),
      issueId: ids["a"]!,
      repositoryId: app.id,
      authorUserId: bob.id,
      body: `@${carol.username} see this`,
    });
    expect(await mentions(carol)).toEqual([]);
  });
});
