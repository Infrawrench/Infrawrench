import { describe, expect, it } from "vitest";
import type { ChangeRow, SuggestedRow } from "../../db/workspace";
import { mentionPattern } from "../../db/workspace";
import { changeStateOf, excerptOf, reasonsOf, summaryOf } from "../handlers/workspace";

const row = (fields: Partial<ChangeRow> = {}): ChangeRow => ({
  pullRequestId: "pull",
  repositoryId: "repo",
  owner: "acme",
  repositoryName: "infra",
  visibility: "private",
  number: 1,
  title: "A change",
  body: "",
  branch: "feature",
  headOid: "a".repeat(40),
  draft: false,
  threadState: "open",
  mergedAt: null,
  authorUserId: "user",
  agentKind: null,
  agentName: null,
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  updatedAt: new Date(0),
  working: false,
  latestVersion: 1,
  verdict: null,
  mustFixOpen: 0,
  ...fields,
});

describe("a branch in a list", () => {
  it("is in the first state that holds", () => {
    expect(changeStateOf(row())).toBe("needs_review");
    expect(changeStateOf(row({ verdict: "approved" }))).toBe("approved");
    // An open must-fix finding outweighs an approval.
    expect(changeStateOf(row({ verdict: "approved", mustFixOpen: 1 }))).toBe("changes_requested");
    expect(changeStateOf(row({ verdict: "changes_requested" }))).toBe("changes_requested");
    expect(changeStateOf(row({ verdict: "changes_requested", working: true }))).toBe(
      "agent_working",
    );
    expect(changeStateOf(row({ threadState: "closed", working: true }))).toBe("closed");
    expect(changeStateOf(row({ threadState: "closed", mergedAt: new Date() }))).toBe("merged");
  });

  it("is summed up by the first line of its description that says something", () => {
    expect(summaryOf("")).toBeNull();
    expect(summaryOf("\n\n---\n")).toBeNull();
    expect(summaryOf("## Limit requests per token\n\nMore.")).toBe("Limit requests per token");
    expect(summaryOf("- Adds a `cache` for **tokens**")).toBe("Adds a cache for tokens");
    const long = summaryOf("word ".repeat(100))!;
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith("…")).toBe(true);
  });

  it("gives its reasons the strongest first", () => {
    const suggested = (fields: Partial<SuggestedRow>): SuggestedRow => ({
      ...row(),
      assigned: false,
      reviewedVersion: null,
      commented: false,
      commentedVersion: null,
      pushes: false,
      total: 1,
      ...fields,
    });
    expect(reasonsOf(suggested({}))).toEqual([]);
    expect(
      reasonsOf(
        suggested({
          pushes: true,
          commented: true,
          commentedVersion: 2,
          reviewedVersion: 1,
          assigned: true,
        }),
      ).map((reason) => `${reason.kind}:${reason.version}`),
    ).toEqual(["assigned:null", "reviewed_before:1", "commented:2", "pushes_to_repository:null"]);
  });
});

describe("a mention", () => {
  const names = (username: string, text: string) =>
    new RegExp(mentionPattern(username), "i").test(text);

  it("is the name after an @, and no part of a longer name or an address", () => {
    expect(names("mara", "@mara")).toBe(true);
    expect(names("mara", "cc @Mara, see above")).toBe(true);
    expect(names("mara", "Thanks @mara.")).toBe(true);
    expect(names("mara", "(@mara)")).toBe(true);
    expect(names("mara", "@marathon")).toBe(false);
    expect(names("mara", "@mara-b")).toBe(false);
    expect(names("mara", "@mara.b")).toBe(false);
    expect(names("mara", "x@mara")).toBe(false);
    expect(names("mara", "mara")).toBe(false);
    // A dot in a name is a dot, not any character.
    expect(names("a.b", "@a.b")).toBe(true);
    expect(names("a.b", "@axb")).toBe(false);
  });

  it("is shown as the line that names them", () => {
    expect(excerptOf("Looks right.\nOne thing, @mara: the limit.\nBye", "mara")).toBe(
      "One thing, @mara: the limit.",
    );
    expect(excerptOf(`@mara ${"word ".repeat(100)}`, "mara").length).toBeLessThanOrEqual(200);
  });
});
