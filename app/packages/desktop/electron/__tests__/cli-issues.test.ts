import { describe, expect, it } from "vitest";
import { sortFiledIssues, type FiledIssueRow } from "../cli/commands/issues";

function row(
  issue: string,
  statusCategory: FiledIssueRow["statusCategory"],
  filedAt: string,
): FiledIssueRow {
  return {
    tracker: "jira",
    issue,
    url: `https://acme.atlassian.net/browse/${issue}`,
    sourceKind: "cost_anomaly",
    sourceId: issue,
    status: null,
    statusCategory,
    assignee: null,
    issueUpdatedAt: null,
    statusSyncedAt: null,
    filedAt,
  };
}

describe("issues CLI ordering", () => {
  it("lists in-progress, then to-do, then unknown, then finished, newest filed first within each", () => {
    const sorted = sortFiledIssues([
      row("DONE-1", "done", "2026-10-10"),
      row("TODO-OLD", "todo", "2026-10-01"),
      row("UNKNOWN", null, "2026-10-12"),
      row("DOING", "in_progress", "2026-09-01"),
      row("TODO-NEW", "todo", "2026-10-05"),
      row("CANCELED", "canceled", "2026-10-15"),
    ]);
    expect(sorted.map((r) => r.issue)).toEqual([
      "DOING",
      "TODO-NEW",
      "TODO-OLD",
      "UNKNOWN",
      "DONE-1",
      "CANCELED",
    ]);
  });
});
