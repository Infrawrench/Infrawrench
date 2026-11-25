/**
 * Issues and pull requests against a real Postgres: one number sequence
 * that holds under concurrency, the counters that move with the rows, the
 * filters the lists serve, and a timeline entry for every change.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Person, type World, configured, makeWorld } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));

describe.skipIf(!configured)("issues and pull requests, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person, carol: Person;
  let repo: string;
  let repositoryId: string;

  beforeAll(async () => {
    world = makeWorld();
    [alice, bob, carol] = (await Promise.all(
      ["alice", "bob", "carol"].map((name) => world.person(name)),
    )) as [Person, Person, Person];
    const made = await world.repository(alice, alice.username, "work");
    repo = made.path;
    repositoryId = made.id;
    await world.call("PUT", `${repo}/collaborators/${carol.username}`, {
      as: alice,
      body: { role: "triage" },
    });
  });
  afterAll(() => world?.cleanup());

  const types = async (number: number, who: Person = alice) =>
    (
      await world.call("GET", `${repo}/issues/${number}/timeline?limit=100`, { as: who })
    ).body.items.map((item: { type: string }) => item.type);

  it("gives issues and pull requests opened at once consecutive numbers from one sequence", async () => {
    const storage = world.storage.repository(repositoryId);
    const pulls = 6;
    for (let i = 0; i < pulls; i++) storage.branches.set(`feature-${i}`, world.storage.nextOid());
    const opened = await Promise.all([
      ...Array.from({ length: 12 }, (_, i) =>
        world.call("POST", `${repo}/issues`, {
          as: i % 2 ? alice : bob,
          body: { title: `Issue ${i}` },
        }),
      ),
      ...Array.from({ length: pulls }, (_, i) =>
        world.call("POST", `${repo}/pulls`, {
          as: bob,
          body: { title: `Pull ${i}`, base: "main", head: `feature-${i}` },
        }),
      ),
    ]);
    expect(opened.map((answer) => answer.status)).toEqual(Array(18).fill(200));
    const numbers = opened.map((answer) => answer.body.number as number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));

    // The counters moved with the rows, and each kind answers only as its own.
    const repository = (await world.call("GET", repo)).body;
    expect(repository).toMatchObject({ openIssueCount: 12, openPullRequestCount: 6 });
    const pullNumber = opened[12]!.body.number as number;
    expect((await world.call("GET", `${repo}/issues/${pullNumber}`)).status).toBe(404);
    expect((await world.call("GET", `${repo}/pulls/${pullNumber}`)).status).toBe(200);
    expect((await world.call("GET", `${repo}/pulls/${opened[0]!.body.number}`)).status).toBe(404);
    // CI can fetch every pull request's head from the base repository.
    expect(storage.pullRefs.size).toBe(pulls);
    // And the same branches cannot be proposed twice.
    const again = await world.call("POST", `${repo}/pulls`, {
      as: bob,
      body: { title: "Again", base: "main", head: "feature-0" },
    });
    expect(again).toMatchObject({ status: 409, body: { code: "pull_request_exists" } });
  });

  it("refuses a pull request with nothing to merge, or from a branch that is not there", async () => {
    const open = (head: string, base = "main") =>
      world.call("POST", `${repo}/pulls`, { as: bob, body: { title: "x", base, head } });
    expect(await open("main")).toMatchObject({ status: 422, body: { code: "no_commits_between" } });
    expect(await open("nowhere")).toMatchObject({ status: 422, body: { code: "ref_not_found" } });
    expect(await open("feature-1", "nowhere")).toMatchObject({
      status: 422,
      body: { code: "ref_not_found" },
    });
    const storage = world.storage.repository(repositoryId);
    storage.branches.set("same", storage.branches.get("main")!);
    expect(await open("same")).toMatchObject({ status: 422, body: { code: "no_commits_between" } });
  });

  it("writes a timeline entry for every change, and lets only the right people make it", async () => {
    const issue = (
      await world.call("POST", `${repo}/issues`, {
        as: bob,
        // Labels from someone without triage are left out, not refused.
        body: { title: "Flaky deploy", body: "It fails.", labels: ["bug"] },
      })
    ).body;
    expect(issue.labels).toEqual([]);
    expect(issue.viewer).toMatchObject({ canEdit: true, canTriage: false, canClose: true });
    const path = `${repo}/issues/${issue.number}`;

    await world.call("POST", `${repo}/labels`, {
      as: carol,
      body: { name: "bug", color: "D73A4A" },
    });
    const milestone = (
      await world.call("POST", `${repo}/milestones`, { as: carol, body: { title: "v1" } })
    ).body;
    expect(
      await world.call("POST", `${repo}/labels`, {
        as: carol,
        body: { name: "BUG", color: "000000" },
      }),
    ).toMatchObject({ status: 409 });
    expect(
      (
        await world.call("POST", `${repo}/labels`, {
          as: bob,
          body: { name: "x", color: "000000" },
        })
      ).status,
    ).toBe(403);

    // The author edits their own text; labels need triage.
    expect((await world.call("PATCH", path, { as: bob, body: { labels: ["bug"] } })).status).toBe(
      403,
    );
    expect(
      (await world.call("PATCH", path, { as: bob, body: { title: "Flaky deploys" } })).status,
    ).toBe(200);
    const triaged = await world.call("PATCH", path, {
      as: carol,
      body: { labels: ["bug"], assignees: [alice.username], milestone: milestone.number },
    });
    expect(triaged.body.labels.map((label: { name: string }) => label.name)).toEqual(["bug"]);
    expect(triaged.body.assignees.map((user: { username: string }) => user.username)).toEqual([
      alice.username,
    ]);
    expect(triaged.body.milestone).toMatchObject({ title: "v1" });
    expect(
      await world.call("PATCH", path, { as: carol, body: { labels: ["nope"] } }),
    ).toMatchObject({ status: 422 });

    await world.call("POST", `${path}/comments`, { as: alice, body: { body: "On it." } });
    const closed = await world.call("PATCH", path, {
      as: bob,
      body: { state: "closed", stateReason: "not_planned" },
    });
    expect(closed.body).toMatchObject({ state: "closed", stateReason: "not_planned" });
    expect(closed.body.closedBy.username).toBe(bob.username);
    // Closing what is closed changes nothing and writes nothing.
    await world.call("PATCH", path, { as: carol, body: { state: "closed" } });
    await world.call("PATCH", path, { as: carol, body: { state: "open" } });

    expect(await types(issue.number)).toEqual([
      "renamed",
      "labeled",
      "assigned",
      "milestoned",
      "comment",
      "closed",
      "reopened",
    ]);
    const milestones = (await world.call("GET", `${repo}/milestones`)).body.milestones;
    expect(milestones[0]).toMatchObject({ openCount: 1, closedCount: 0 });

    // A stranger with read access can do none of it.
    const dave = await world.person("dave");
    expect(
      (await world.call("PATCH", path, { as: dave, body: { title: "Mine now" } })).status,
    ).toBe(403);
    expect((await world.call("PATCH", path, { body: { title: "Anonymous" } })).status).toBe(401);
  });

  it("serves the list's filters, search and counts", async () => {
    const list = async (query: string, who?: Person) =>
      (await world.call("GET", `${repo}/issues?limit=100&${query}`, { as: who })).body;
    const titles = (body: { items: Array<{ title: string }> }) =>
      body.items.map((item) => item.title).sort();

    expect(titles(await list("label=bug&state=all"))).toEqual(["Flaky deploys"]);
    expect(titles(await list(`assignee=${alice.username}&state=all`))).toEqual(["Flaky deploys"]);
    expect(titles(await list("assignee=@me&state=all", alice))).toEqual(["Flaky deploys"]);
    expect(titles(await list("milestone=1&state=all"))).toEqual(["Flaky deploys"]);
    expect(titles(await list("q=flaky"))).toEqual(["Flaky deploys"]);
    expect(titles(await list("q=100%25_nothing"))).toEqual([]);
    expect(titles(await list("label=does-not-exist"))).toEqual([]);
    expect((await list(`author=${alice.username}`)).items).toHaveLength(6);
    expect((await list("milestone=none")).counts).toEqual({ open: 12, closed: 0 });
    expect((await list("")).counts).toEqual({ open: 13, closed: 0 });

    // Pages do not repeat or skip, whichever way they are sorted.
    for (const sort of ["created", "updated", "comments"]) {
      const seen: number[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: Array<{ number: number }>; nextCursor: string | null } = (
          await world.call(
            "GET",
            `${repo}/issues?limit=5&sort=${sort}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          )
        ).body;
        seen.push(...page.items.map((item) => item.number));
        cursor = page.nextCursor;
      } while (cursor);
      expect(new Set(seen).size, sort).toBe(13);
      expect(seen, sort).toHaveLength(13);
    }

    const pulls = (await world.call("GET", `${repo}/pulls?limit=100&head=feature-2`)).body;
    expect(pulls.items.map((item: { headRef: string }) => item.headRef)).toEqual(["feature-2"]);
    expect(pulls.counts).toEqual({ open: 1, closed: 0 });
    expect((await world.call("GET", `${repo}/pulls?state=merged`)).body.items).toEqual([]);
  });

  it("locks a conversation to everyone below triage", async () => {
    const issue = (
      await world.call("POST", `${repo}/issues`, { as: bob, body: { title: "Heated" } })
    ).body;
    const path = `${repo}/issues/${issue.number}`;
    expect((await world.call("PUT", `${path}/lock`, { as: bob, body: {} })).status).toBe(403);
    expect(
      (await world.call("PUT", `${path}/lock`, { as: carol, body: { reason: "too heated" } }))
        .status,
    ).toBe(200);
    expect(
      await world.call("POST", `${path}/comments`, { as: bob, body: { body: "But" } }),
    ).toMatchObject({ status: 422, body: { code: "locked" } });
    expect(
      (await world.call("POST", `${path}/comments`, { as: carol, body: { body: "Enough." } }))
        .status,
    ).toBe(200);
    expect((await world.call("GET", path, { as: bob })).body.viewer.canComment).toBe(false);
    await world.call("DELETE", `${path}/lock`, { as: carol });
    expect(await types(issue.number)).toEqual(["locked", "comment", "unlocked"]);
  });

  it("lets a comment's author or a maintainer change it, and notes a mention once", async () => {
    const first = (
      await world.call("POST", `${repo}/issues`, { as: bob, body: { title: "Target" } })
    ).body;
    const second = (
      await world.call("POST", `${repo}/issues`, {
        as: bob,
        body: { title: "Source", body: `Same as #${first.number}, see #${first.number}.` },
      })
    ).body;
    await world.call("POST", `${repo}/issues/${second.number}/comments`, {
      as: bob,
      body: { body: `Still #${first.number}` },
    });
    const timeline = (await world.call("GET", `${repo}/issues/${first.number}/timeline`)).body
      .items;
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      type: "cross_referenced",
      source: { number: second.number, title: "Source", isPullRequest: false, state: "open" },
    });

    const comment = (
      await world.call("POST", `${repo}/issues/${first.number}/comments`, {
        as: bob,
        body: { body: "v1" },
      })
    ).body;
    expect(comment).toMatchObject({ authorAccess: "author", edited: false, viewerCanEdit: true });
    const edit = (who: Person) =>
      world.call("PATCH", `${repo}/issues/comments/${comment.id}`, {
        as: who,
        body: { body: "v2" },
      });
    expect((await edit(carol)).status).toBe(403);
    expect((await edit(bob)).body).toMatchObject({ body: "v2", edited: true });
    expect(
      (await world.call("DELETE", `${repo}/issues/comments/${comment.id}`, { as: alice })).status,
    ).toBe(200);
    expect((await world.call("GET", `${repo}/issues/${first.number}`)).body.commentCount).toBe(0);
  });
});
