/**
 * An issue import against a real Postgres, with GitHub played by a `fetch`
 * that serves the fixtures in `fixtures/github-issues/` (written by hand in
 * GitHub's response shape; nobody in them is real): paging, a rate limit
 * half way, numbering beside a thread that already has the number, whose
 * account a login is, a second run, and what happens to the token.
 */
import { readFileSync } from "node:fs";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  gitComments,
  gitCommitEmails,
  gitIssueImports,
  gitIssues,
  gitRepositories,
  gitTimelineEvents,
} from "@infrawrench/server-core/db/schema";
import { db, newId } from "../../db/client";
import type { GitHubFetch } from "../../import/github";
import { MAX_AGAIN_SECONDS, runIssueImportJob } from "../../import/job";
import { issueImportsDue } from "../../import/store";
import { type Person, type World, configured, makeWorld } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));

process.env["ENCRYPTION_MASTER_KEY"] ??= Buffer.alloc(32, 7).toString("base64");

/** Not in any real token's format. */
const TOKEN = "fixture-credential-7f3a9c1e5b2d";
const SOURCE = "acme-example/widgets";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/github-issues/${name}.json`, import.meta.url), "utf8");

interface Request {
  readonly path: string;
  readonly query: Record<string, string>;
}

interface FakeGitHub {
  readonly fetch: GitHubFetch;
  readonly requests: Request[];
  /** Every header and option a request carried, to check what was sent where. */
  readonly inits: RequestInit[];
  readonly urls: string[];
  issues: any[];
  comments: any[];
  /** Answer the next request to this path and page with a rate limit, once. */
  limitOnce: { path: string; page: string; resetAt: number } | null;
  /** Answer everything with this status. */
  status: number | null;
}

/**
 * GitHub, as much as an import reads: lists paged with a `Link` header
 * (four issues and three comments a page, so the fixtures span two pages of
 * each), `since` honoured, profiles by login.
 */
const fakeGitHub = (rename: Record<string, string>): FakeGitHub => {
  const text = (name: string) =>
    Object.entries(rename).reduce((out, [from, to]) => out.replaceAll(from, to), fixture(name));
  const profiles: Record<string, unknown> = JSON.parse(text("users"));
  const labels: unknown[] = JSON.parse(text("labels"));
  const milestones: unknown[] = JSON.parse(text("milestones"));
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-remaining": "4000",
        "x-ratelimit-reset": "1900000000",
        ...headers,
      },
    });
  const paged = (items: any[], url: URL, size: number) => {
    const since = url.searchParams.get("since");
    const kept = since
      ? items.filter((item) => new Date(item.updated_at).getTime() >= new Date(since).getTime())
      : items;
    const ordered = url.searchParams.get("direction") === "desc" ? [...kept].reverse() : kept;
    const perPage = Math.min(size, Number(url.searchParams.get("per_page") ?? 30));
    const page = Number(url.searchParams.get("page") ?? 1);
    const slice = ordered.slice((page - 1) * perPage, page * perPage);
    const more = page * perPage < ordered.length;
    return json(
      slice,
      200,
      more ? { link: `<${url.origin}${url.pathname}?page=${page + 1}>; rel="next"` } : {},
    );
  };
  const github: FakeGitHub = {
    requests: [],
    inits: [],
    urls: [],
    issues: JSON.parse(text("issues")),
    comments: JSON.parse(text("comments")),
    limitOnce: null,
    status: null,
    fetch: async (raw, init) => {
      const url = new URL(raw);
      const path = url.pathname;
      github.urls.push(raw);
      github.inits.push(init);
      github.requests.push({ path, query: Object.fromEntries(url.searchParams) });
      if (github.status !== null) {
        return json(
          { message: "Bad credentials", documentation_url: "https://docs" },
          github.status,
        );
      }
      const limit = github.limitOnce;
      if (limit && limit.path === path && limit.page === url.searchParams.get("page")) {
        github.limitOnce = null;
        return json({ message: "API rate limit exceeded for user ID 5300001." }, 403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(limit.resetAt / 1000)),
        });
      }
      const base = `/repos/${SOURCE}`;
      if (path === `${base}/labels`) return paged(labels, url, 100);
      if (path === `${base}/milestones`) return paged(milestones, url, 100);
      if (path === `${base}/issues`) return paged(github.issues, url, 4);
      if (path === `${base}/issues/comments`) return paged(github.comments, url, 3);
      if (path.startsWith("/users/")) {
        const profile = profiles[decodeURIComponent(path.slice("/users/".length))];
        return profile ? json(profile) : json({ message: "Not Found" }, 404);
      }
      return json({ message: "Not Found" }, 404);
    },
  };
  return github;
};

describe.skipIf(!configured)("importing issues from GitHub, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person, carol: Person, dave: Person, erin: Person;
  let repo: string;
  let repositoryId: string;
  let github: FakeGitHub;
  let offset = 0;
  const now = () => Date.now() + offset;
  const logged: string[] = [];

  const start = async (as: Person = alice) =>
    world.call("POST", `${repo}/issue-imports`, {
      as,
      body: { source: "github", repository: SOURCE, token: TOKEN },
    });
  const step = (importId: string, maxRequests = 3) =>
    runIssueImportJob(world.env, importId, { fetch: github.fetch, now, maxRequests });
  /** Step until the import says it has no more to do now. The outcomes, in order. */
  const run = async (importId: string, maxRequests = 3) => {
    const outcomes: Array<{ again?: number }> = [];
    for (let i = 0; i < 60; i++) {
      const outcome = await step(importId, maxRequests);
      outcomes.push(outcome);
      if (outcome.again !== 0) return outcomes;
    }
    throw new Error("the import did not come to rest");
  };
  const importRow = async (importId: string) =>
    (await db.select().from(gitIssueImports).where(eq(gitIssueImports.id, importId)))[0]!;
  const imported = () =>
    db
      .select()
      .from(gitIssues)
      .where(and(eq(gitIssues.repositoryId, repositoryId), isNotNull(gitIssues.importId)))
      .orderBy(gitIssues.importNumber);
  const importedComments = () =>
    db
      .select()
      .from(gitComments)
      .where(and(eq(gitComments.repositoryId, repositoryId), isNotNull(gitComments.importId)))
      .orderBy(gitComments.importId);
  const nextNumber = async () =>
    (
      await db
        .select({ next: gitRepositories.nextNumber })
        .from(gitRepositories)
        .where(eq(gitRepositories.id, repositoryId))
    )[0]!.next;

  beforeAll(async () => {
    world = makeWorld();
    [alice, bob, carol, dave, erin] = (await Promise.all(
      ["alice", "bob", "carol", "dave", "erin"].map((name) => world.person(name)),
    )) as [Person, Person, Person, Person, Person];
    const made = await world.repository(alice, alice.username, "widgets");
    repo = made.path;
    repositoryId = made.id;
    await world.call("PUT", `${repo}/collaborators/${carol.username}`, {
      as: alice,
      body: { role: "triage" },
    });
    await world.call("PUT", `${repo}/collaborators/${erin.username}`, {
      as: alice,
      body: { role: "write" },
    });
    // An address alice has proved is hers, in her own namespace.
    await db.insert(gitCommitEmails).values({
      id: newId(),
      organizationId: null,
      userId: alice.id,
      email: `mona-${world.suffix}@elsewhere.example.test`,
      verifiedAt: new Date(),
    });
    // The same kind of row, never proved: it must not count.
    await db.insert(gitCommitEmails).values({
      id: newId(),
      organizationId: null,
      userId: alice.id,
      email: `unproved-${world.suffix}@elsewhere.example.test`,
    });
    // A branch's page takes number 1, which is also an issue's number at the source.
    world.storage.repository(repositoryId).branches.set("feature", world.storage.nextOid());
    const page = await world.call("POST", `${repo}/branch-pages`, {
      as: alice,
      body: { title: "A branch", base: "main", head: "feature" },
    });
    expect(page).toMatchObject({ status: 200, body: { number: 1 } });

    github = fakeGitHub({
      // (a) the address on the profile: a proved commit email, and an account's own (in another case).
      "MONA-EMAIL": `mona-${world.suffix}@elsewhere.example.test`,
      "HUBOT-EMAIL": bob.email.toUpperCase(),
      // (b) the same name here: a collaborator's, and a stranger's.
      "casey-example": carol.username,
      "drew-example": dave.username,
    });
  });
  afterAll(() => world?.cleanup());

  beforeEach(() => {
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(
          args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
        );
      });
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it("is an administrator's, takes one at a time, and never answers the token", async () => {
    expect((await start(erin)).status).toBe(403);
    expect((await world.call("GET", `${repo}/issue-imports`, { as: erin })).status).toBe(403);
    expect((await world.call("GET", `${repo}/issue-imports`)).status).toBe(401);
    expect(
      await world.call("POST", `${repo}/issue-imports`, {
        as: alice,
        body: {
          source: "github",
          repository: "https://github.com/acme-example/widgets",
          token: TOKEN,
        },
      }),
    ).toMatchObject({ status: 400 });

    const first = await start();
    expect(first).toMatchObject({
      status: 200,
      body: {
        source: "github",
        repository: SOURCE,
        status: "queued",
        phase: "labels",
        counts: { labels: 0, milestones: 0, issues: 0, comments: 0 },
        error: null,
        startedBy: { username: alice.username },
      },
    });
    expect(JSON.stringify(first.body)).not.toContain(TOKEN);
    expect(await start()).toMatchObject({ status: 409 });

    // Sealed in the row, not written as it came.
    const row = await importRow(first.body.id);
    expect(row.tokenEncrypted).not.toBe(null);
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    // No queue here, so it is the sweep's at once.
    expect(await issueImportsDue()).toContain(first.body.id);

    const cancelled = await world.call("POST", `${repo}/issue-imports/${first.body.id}/cancel`, {
      as: alice,
    });
    expect(cancelled).toMatchObject({ status: 200, body: { status: "cancelled" } });
    expect(await importRow(first.body.id)).toMatchObject({
      status: "cancelled",
      tokenEncrypted: null,
      tokenIv: null,
    });
    expect(await step(first.body.id)).toEqual({});
    expect(github.requests).toHaveLength(0);
    expect(await issueImportsDue()).not.toContain(first.body.id);
    expect(
      (await world.call("POST", `${repo}/issue-imports/${newId()}/cancel`, { as: alice })).status,
    ).toBe(404);
  });

  let firstImportId = "";

  it("stops at a rate limit and carries on at the page it stopped on", async () => {
    const created = await start();
    expect(created.status).toBe(200);
    firstImportId = created.body.id;
    const resetAt = now() + 1200_000;
    github.limitOnce = { path: `/repos/${SOURCE}/issues`, page: "2", resetAt };

    const outcomes = await run(firstImportId);
    // Several steps of three requests each, then the wait: as long as a queue's delay may be.
    expect(outcomes.length).toBeGreaterThan(1);
    expect(outcomes.at(-1)).toEqual({ again: MAX_AGAIN_SECONDS });
    const waiting = await importRow(firstImportId);
    expect(waiting).toMatchObject({ status: "running", phase: "issues", error: null });
    expect(waiting.progress).toMatchObject({ page: 2, labels: 3, milestones: 2, issues: 3 });
    expect(Math.abs(waiting.resumeAt!.getTime() - Math.floor(resetAt / 1000) * 1000)).toBeLessThan(
      1000,
    );
    expect(waiting.tokenEncrypted).not.toBe(null);
    // The first page's three issues are written; the pull request among them is not.
    expect((await imported()).map((issue) => issue.importNumber)).toEqual([1, 3, 4]);
    expect(
      (await world.call("GET", `${repo}/issue-imports`, { as: alice })).body.imports[0],
    ).toMatchObject({ id: firstImportId, status: "running", phase: "issues" });

    // A message that comes back early asks to be sent again and asks GitHub nothing.
    const asked = github.requests.length;
    expect(await step(firstImportId)).toEqual({ again: MAX_AGAIN_SECONDS });
    expect(github.requests.length).toBe(asked);
    // Nor is it the sweep's while it waits.
    expect(await issueImportsDue(new Date(now() + 10 * 60_000))).not.toContain(firstImportId);
    offset = 1000_000;
    expect((await step(firstImportId)).again).toBe(200);
    expect(github.requests.length).toBe(asked);

    offset = 1201_000;
    expect((await run(firstImportId)).at(-1)).toEqual({});
    // It went on with the page it was refused, and read no page of issues twice.
    expect(github.requests[asked]).toMatchObject({
      path: `/repos/${SOURCE}/issues`,
      query: { page: "2", direction: "asc" },
    });
    const issuePages = (requests: readonly Request[]) =>
      requests
        .filter((r) => r.path === `/repos/${SOURCE}/issues` && r.query["direction"] === "asc")
        .map((r) => r.query["page"]);
    // Before the wait: page 1 (again while its authors were looked up, three requests a step), then the refusal.
    expect(new Set(issuePages(github.requests.slice(0, asked)).slice(0, -1))).toEqual(
      new Set(["1"]),
    );
    expect(issuePages(github.requests.slice(0, asked)).at(-1)).toBe("2");
    expect(issuePages(github.requests.slice(asked))).toEqual(["2"]);
    expect(
      github.requests
        .filter((r) => r.path === `/repos/${SOURCE}/issues/comments`)
        .map((r) => r.query["page"]),
    ).toEqual(["1", "2"]);
    // The first run asks for everything.
    expect(github.requests.every((r) => r.query["since"] === undefined)).toBe(true);
  });

  it("ends done, with the token gone and nothing of it anywhere", async () => {
    const row = await importRow(firstImportId);
    expect(row).toMatchObject({
      status: "done",
      phase: "finish",
      error: null,
      resumeAt: null,
      tokenEncrypted: null,
      tokenIv: null,
    });
    expect(row.finishedAt).not.toBe(null);
    expect(row.progress).toMatchObject({ labels: 3, milestones: 2, issues: 5, comments: 5 });
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(logged.join("\n")).not.toContain(TOKEN);

    // Every request went to GitHub's API, with the token, and would follow no redirect.
    expect(github.urls.length).toBeGreaterThan(8);
    for (const url of github.urls) expect(url.startsWith("https://api.github.com/")).toBe(true);
    for (const init of github.inits) {
      expect(init.redirect).toBe("manual");
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    }
    // One profile read per login, a bot's and a deleted account's never.
    const profiles = github.requests.filter((r) => r.path.startsWith("/users/")).map((r) => r.path);
    expect([...profiles].sort()).toEqual(
      ["hubot-example", "mona-example", carol.username, dave.username]
        .map((login) => `/users/${login}`)
        .sort(),
    );
  });

  it("numbers an issue as GitHub did unless a thread here has that number", async () => {
    const issues = await imported();
    // #1 is the branch's page, so GitHub's #1 is numbered past everything GitHub has (its #7).
    expect(issues.map((issue) => [issue.importNumber, issue.number])).toEqual([
      [1, 8],
      [3, 3],
      [4, 4],
      [6, 6],
      [7, 7],
    ]);
    expect(issues.every((issue) => !issue.isPullRequest && issue.importSource === "github")).toBe(
      true,
    );
    expect(await nextNumber()).toBe(9);
    // GitHub's pull requests (#2, #5) are gaps, and a new thread does not fill one.
    const opened = await world.call("POST", `${repo}/issues`, {
      as: alice,
      body: { title: "Written here" },
    });
    expect(opened).toMatchObject({ status: 200, body: { number: 9, imported: null } });
    expect((await world.call("GET", `${repo}/issues/2`, { as: alice })).status).toBe(404);
    expect((await world.call("GET", `${repo}/issues/5`, { as: alice })).status).toBe(404);
    // The page that had the number still has it.
    expect((await world.call("GET", `${repo}/issues/1`, { as: alice })).status).toBe(404);
    expect((await world.call("GET", `${repo}/branch-pages/1`, { as: alice })).status).toBe(200);
  });

  it("gives an issue to an account by its profile address or, with access, its name", async () => {
    const byNumber = new Map((await imported()).map((issue) => [issue.importNumber, issue]));
    // (a) a proved commit email in this namespace.
    expect(byNumber.get(1)).toMatchObject({ authorUserId: alice.id, importAuthor: "mona-example" });
    // A deleted account.
    expect(byNumber.get(3)).toMatchObject({ authorUserId: null, importAuthor: "ghost" });
    // (a) an account's own address, whatever its case; that person has no access here.
    expect(byNumber.get(4)).toMatchObject({ authorUserId: bob.id, importAuthor: "hubot-example" });
    // (b) a collaborator's username.
    expect(byNumber.get(6)).toMatchObject({
      authorUserId: carol.id,
      importAuthor: carol.username,
    });
    // (b) refused: the same name, but nothing here says this person reaches the repository.
    expect(byNumber.get(7)).toMatchObject({ authorUserId: null, importAuthor: dave.username });

    const one = (await world.call("GET", `${repo}/issues/8`, { as: alice })).body;
    expect(one).toMatchObject({
      number: 8,
      author: { username: alice.username },
      imported: {
        source: "github",
        author: "mona-example",
        url: "https://github.com/acme-example/widgets/issues/1",
        number: 1,
      },
      // Of its two assignees, the one with an account here.
      assignees: [{ username: alice.username }],
      labels: [{ name: "bug", color: "d73a4a" }],
      milestone: { title: "v1.0" },
      closedBy: null,
    });
    const seven = (await world.call("GET", `${repo}/issues/7`)).body;
    expect(seven).toMatchObject({
      author: null,
      imported: { author: dave.username, number: 7 },
    });
  });

  it("keeps what was written and when, and the state", async () => {
    const get = async (number: number) =>
      (await world.call("GET", `${repo}/issues/${number}`, { as: alice })).body;
    expect(await get(8)).toMatchObject({
      title: "Widget crashes on start",
      body: "Starting the widget with an empty config throws.\n\nSee #2 for the fix.",
      state: "closed",
      stateReason: "completed",
      locked: false,
      createdAt: "2023-01-05T10:15:00.000Z",
      updatedAt: "2023-01-20T16:45:30.000Z",
      closedAt: "2023-01-20T16:45:30.000Z",
      commentCount: 2,
    });
    expect(await get(3)).toMatchObject({
      body: "",
      state: "open",
      stateReason: null,
      closedAt: null,
    });
    expect(await get(4)).toMatchObject({
      state: "closed",
      stateReason: "not_planned",
      locked: true,
      lockReason: "resolved",
      commentCount: 0,
    });
    expect(await get(6)).toMatchObject({
      state: "open",
      stateReason: null,
      labels: [{ name: "enhancement" }, { name: "good first issue" }],
      milestone: { title: "v2.0" },
      assignees: [{ username: carol.username }],
    });
    expect(await get(7)).toMatchObject({ state: "closed", stateReason: "not_planned" });

    const comments = await importedComments();
    expect(comments.map((comment) => comment.importId)).toEqual([
      "9100000001",
      "9100000003",
      "9100000004",
      "9100000005",
      "9100000006",
    ]);
    const listed = (await world.call("GET", `${repo}/issues/8/comments`, { as: alice })).body.items;
    expect(listed).toMatchObject([
      {
        body: "I can reproduce this.",
        author: { username: bob.username },
        createdAt: "2023-01-06T08:00:00.000Z",
        edited: false,
        imported: {
          source: "github",
          author: "hubot-example",
          url: "https://github.com/acme-example/widgets/issues/1#issuecomment-9100000001",
          number: null,
        },
      },
      { body: "Same here.", author: null, imported: { author: "ghost" } },
    ]);
    const six = (await world.call("GET", `${repo}/issues/6/comments`, { as: alice })).body.items;
    expect(six).toMatchObject([
      {
        author: { username: alice.username },
        edited: true,
        createdAt: "2023-03-06T07:10:00.000Z",
        updatedAt: "2023-03-06T07:25:00.000Z",
      },
    ]);
    const bot = comments.find((comment) => comment.importId === "9100000006")!;
    expect(bot).toMatchObject({ authorUserId: null, importAuthor: "tidy-example[bot]" });
  });

  it("leaves the counters as the rows say, and writes no timeline", async () => {
    const repository = (await world.call("GET", repo, { as: alice })).body;
    // GitHub's #3 and #6, and the one written here since.
    expect(repository).toMatchObject({ openIssueCount: 3, openBranchCount: 1 });
    const milestones = (await world.call("GET", `${repo}/milestones?state=all`, { as: alice })).body
      .milestones;
    expect(milestones).toMatchObject([
      { title: "v1.0", state: "closed", dueOn: "2023-03-01", openCount: 0, closedCount: 1 },
      { title: "v2.0", state: "open", dueOn: null, openCount: 1, closedCount: 0 },
    ]);
    const labels = (await world.call("GET", `${repo}/labels`, { as: alice })).body.labels;
    expect(labels).toMatchObject([
      { name: "bug", color: "d73a4a", description: "Something isn't working" },
      { name: "enhancement", color: "a2eeef" },
      { name: "good first issue", color: "7057ff", description: null },
    ]);
    const counts = (await world.call("GET", `${repo}/issues?state=all`, { as: alice })).body;
    expect(counts.counts).toEqual({ open: 3, closed: 3 });
    const ids = (await imported()).map((issue) => issue.id);
    for (const issueId of ids) {
      expect(
        await db.select().from(gitTimelineEvents).where(eq(gitTimelineEvents.issueId, issueId)),
      ).toEqual([]);
    }
    // "See #2" in an imported body made no reference on anything.
    expect(
      await db
        .select()
        .from(gitTimelineEvents)
        .where(eq(gitTimelineEvents.repositoryId, repositoryId)),
    ).toEqual([]);
  });

  it("run again, adds nothing twice and takes what changed at the source", async () => {
    const before = await imported();
    const commentsBefore = await importedComments();
    // Edited at GitHub since: a title and body, a comment, and an issue closed.
    const later = new Date(now() + 60_000).toISOString();
    github.issues = github.issues.map((issue) =>
      issue.number === 3
        ? {
            ...issue,
            title: "Document the config file format",
            body: "Now with a body.",
            updated_at: later,
          }
        : issue.number === 6
          ? {
              ...issue,
              state: "closed",
              state_reason: "completed",
              closed_at: later,
              updated_at: later,
            }
          : issue,
    );
    github.comments = github.comments.map((comment) =>
      comment.id === 9100000005
        ? { ...comment, body: "I will take this next week.", updated_at: later }
        : comment,
    );
    // Closed here meanwhile, and unchanged at the source: left as it is here.
    expect(
      (
        await world.call("PATCH", `${repo}/issues/3`, {
          as: alice,
          body: { state: "closed", stateReason: "completed" },
        })
      ).status,
    ).toBe(200);
    github.requests.length = 0;

    const again = await start();
    expect(again.status).toBe(200);
    const stored = await importRow(again.body.id);
    expect(stored.progress.since).toBe((await importRow(firstImportId)).createdAt.toISOString());
    expect((await run(again.body.id, 40)).at(-1)).toEqual({});
    expect(await importRow(again.body.id)).toMatchObject({
      status: "done",
      tokenEncrypted: null,
      tokenIv: null,
    });
    // Only what changed since the first run began was asked for.
    const lists = github.requests.filter(
      (r) => r.path.endsWith("/issues") || r.path.endsWith("/issues/comments"),
    );
    expect(lists.filter((r) => r.query["direction"] === "asc").every((r) => r.query["since"])).toBe(
      true,
    );

    const after = await imported();
    expect(after.map((issue) => [issue.id, issue.number, issue.importNumber])).toEqual(
      before.map((issue) => [issue.id, issue.number, issue.importNumber]),
    );
    expect((await importedComments()).map((comment) => comment.id)).toEqual(
      commentsBefore.map((comment) => comment.id),
    );
    expect(await nextNumber()).toBe(10);

    const three = (await world.call("GET", `${repo}/issues/3`, { as: alice })).body;
    expect(three).toMatchObject({
      title: "Document the config file format",
      body: "Now with a body.",
      // The source says it is open, and it changed there.
      state: "open",
      commentCount: 1,
    });
    expect((await world.call("GET", `${repo}/issues/6`, { as: alice })).body).toMatchObject({
      state: "closed",
      stateReason: "completed",
    });
    expect(
      (await world.call("GET", `${repo}/issues/3/comments`, { as: alice })).body.items,
    ).toMatchObject([{ body: "I will take this next week.", edited: true }]);
    // The counters follow: #3 and the one written here are open, #6 is not.
    expect((await world.call("GET", repo, { as: alice })).body).toMatchObject({
      openIssueCount: 2,
    });
    expect(
      (await world.call("GET", `${repo}/milestones?state=all`, { as: alice })).body.milestones,
    ).toMatchObject([
      { title: "v1.0", openCount: 0, closedCount: 1 },
      { title: "v2.0", openCount: 0, closedCount: 1 },
    ]);
  });

  it("fails with a plain sentence when GitHub refuses the token", async () => {
    github.status = 401;
    const created = await start();
    expect(await run(created.body.id)).toEqual([{}]);
    const row = await importRow(created.body.id);
    expect(row).toMatchObject({
      status: "failed",
      error: "GitHub refused the token",
      tokenEncrypted: null,
      tokenIv: null,
    });
    expect(row.finishedAt).not.toBe(null);
    expect(
      (await world.call("GET", `${repo}/issue-imports`, { as: alice })).body.imports[0],
    ).toMatchObject({ status: "failed", error: "GitHub refused the token" });

    github.status = 404;
    const missing = await start();
    expect(await run(missing.body.id)).toEqual([{}]);
    expect(await importRow(missing.body.id)).toMatchObject({
      status: "failed",
      error: "No such repository, or the token cannot read it",
      tokenEncrypted: null,
    });
    github.status = null;

    const everything = [
      ...logged,
      JSON.stringify(
        await db
          .select()
          .from(gitIssueImports)
          .where(eq(gitIssueImports.repositoryId, repositoryId)),
      ),
    ].join("\n");
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("Bad credentials");
  });

  it("gives up nothing to a second message while a step holds the import", async () => {
    const created = await start();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow: GitHubFetch = async (url, init) => {
      await held;
      return github.fetch(url, init);
    };
    const first = runIssueImportJob(world.env, created.body.id, {
      fetch: slow,
      now,
      maxRequests: 1,
    });
    // Let the first step claim the row before the second message arrives.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await step(created.body.id)).toEqual({});
    release();
    expect(await first).toEqual({ again: 0 });
    expect((await run(created.body.id, 40)).at(-1)).toEqual({});
    expect(await importRow(created.body.id)).toMatchObject({ status: "done" });
    expect((await imported()).length).toBe(5);
  });
});
