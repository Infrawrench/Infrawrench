import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@infrawrench/git-contract";
import { shortAge } from "../../../lib/format";
import {
  activityActor,
  activityVerb,
  headline,
  listOf,
  pushedSentence,
  reasonText,
  reviewTime,
} from "../sentences";

const repository = (name: string) => ({
  id: name,
  owner: "acme",
  name,
  visibility: "private" as const,
});

const event = (fields: Partial<ActivityEvent>): ActivityEvent => ({
  id: "event",
  type: "pushed",
  at: "2026-01-01T00:00:00.000Z",
  actor: { id: "user", username: "ian", displayName: "Ian", avatarUrl: null },
  agent: null,
  repository: repository("web"),
  number: 1,
  title: "A change",
  version: 3,
  findings: null,
  ...fields,
});

describe("the home page's sentences", () => {
  it("counts active branches for a team, for one person, and for nobody", () => {
    expect(headline({ activeBranches: 15, shared: true })).toBe("Your team has 15 active branches");
    expect(headline({ activeBranches: 3, shared: false })).toBe("You have 3 active branches");
    expect(headline({ activeBranches: 1, shared: false })).toBe("You have 1 active branch");
    expect(headline({ activeBranches: 0, shared: true })).toBe("No active branches");
  });

  it("lists names with commas, and the ones it leaves out as a count", () => {
    expect(listOf([])).toBe("");
    expect(listOf(["web"])).toBe("web");
    expect(listOf(["web", "worker"])).toBe("web and worker");
    expect(listOf(["web", "worker", "infra"])).toBe("web, worker, and infra");
    expect(listOf(["a", "b", "c", "d", "e"])).toBe("a, b, c, and 2 more");
  });

  it("says where work was pushed in the window, or that nothing was", () => {
    const pushed = (days: number, names: string[]) => ({
      days,
      versions: names.length,
      repositories: names.map(repository),
    });
    expect(pushedSentence({ shared: true, pushed: pushed(7, ["web", "worker", "infra"]) })).toBe(
      "In the last week, your team has pushed changes to web, worker, and infra.",
    );
    expect(pushedSentence({ shared: false, pushed: pushed(1, ["web"]) })).toBe(
      "In the last day, you have pushed changes to web.",
    );
    expect(pushedSentence({ shared: true, pushed: pushed(30, []) })).toBe(
      "Nothing was pushed in the last 30 days.",
    );
  });

  it("estimates a review from the size of the change", () => {
    expect(reviewTime({ additions: 3, deletions: 1 })).toBe("1m review");
    expect(reviewTime({ additions: 300, deletions: 100 })).toBe("10m review");
    expect(reviewTime({ additions: 4000, deletions: 0 })).toBe("1h+ review");
  });

  it("words each reason a branch is suggested", () => {
    expect(reasonText({ kind: "assigned", version: null }, "web")).toEqual({
      text: "Assigned to you",
      strong: null,
    });
    expect(reasonText({ kind: "commented", version: 2 }, "web")).toEqual({
      text: "You commented on",
      strong: "v2",
    });
    expect(reasonText({ kind: "reviewed_before", version: 4 }, "web").strong).toBe("v4");
    expect(reasonText({ kind: "pushes_to_repository", version: null }, "web")).toEqual({
      text: "Because you push to",
      strong: "web",
    });
  });

  it("words each kind of activity, naming the agent when one pushed", () => {
    expect(activityVerb(event({}))).toBe("pushed v3 to");
    expect(activityActor(event({ agent: "T3 Code" }))).toBe("T3 Code");
    expect(activityActor(event({}))).toBe("Ian");
    expect(activityVerb(event({ type: "changes_requested" }))).toBe("requested changes on");
    const run = event({ type: "findings", actor: null, findings: { found: 3, mustFix: 2 } });
    expect(activityActor(run)).toBe("Review agents");
    expect(activityVerb(run)).toBe("found 2 must fix on");
    expect(activityVerb(event({ type: "findings", findings: { found: 1, mustFix: 0 } }))).toBe(
      "found 1 finding on",
    );
  });

  it("shortens an age to a few characters", () => {
    const now = Date.parse("2026-06-01T12:00:00.000Z");
    const ago = (minutes: number) => shortAge(new Date(now - minutes * 60_000).toISOString(), now);
    expect(ago(0)).toBe("now");
    expect(ago(51)).toBe("51m");
    expect(ago(16 * 60)).toBe("16h");
    expect(ago(3 * 24 * 60)).toBe("3d");
    expect(ago(21 * 24 * 60)).toBe("3w");
  });
});
