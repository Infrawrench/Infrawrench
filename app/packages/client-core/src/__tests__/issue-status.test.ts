import { describe, expect, it } from "vitest";
import {
  githubStatusCategory,
  githubStatusName,
  isIssueReadingFresh,
  isIssueStatusCategory,
  isIssueStatusClosed,
  issueBecameDone,
  issueHandle,
  issueStatusChanged,
  jiraStatusCategory,
  linearStatusCategory,
} from "../issue-status";
import {
  budgetAlertIssueDraft,
  budgetAlertIssueFacts,
  describeBudgetFilter,
} from "../budget-alert-issues";
import { buildJiraIssueDraft, JIRA_SOURCE_KINDS, jiraSourceKindLabel } from "../jira";
import { GITHUB_ISSUE_SOURCE_KINDS, githubSourceKindLabel } from "../github-issues";
import type { BudgetWithStatus } from "../costs";

describe("status categories", () => {
  it("maps Jira status categories", () => {
    expect(jiraStatusCategory("new")).toBe("todo");
    expect(jiraStatusCategory("indeterminate")).toBe("in_progress");
    expect(jiraStatusCategory("done")).toBe("done");
    expect(jiraStatusCategory("undefined")).toBeNull();
    expect(jiraStatusCategory(null)).toBeNull();
  });

  it("maps every Linear workflow state type", () => {
    expect(["triage", "backlog", "unstarted"].map(linearStatusCategory)).toEqual([
      "todo",
      "todo",
      "todo",
    ]);
    expect(linearStatusCategory("started")).toBe("in_progress");
    expect(linearStatusCategory("completed")).toBe("done");
    expect(linearStatusCategory("canceled")).toBe("canceled");
    expect(linearStatusCategory("duplicate")).toBe("canceled");
    expect(linearStatusCategory("something-new")).toBeNull();
  });

  it("reads GitHub's close reason, treating a reasonless close as done", () => {
    expect(githubStatusCategory("open", null)).toBe("todo");
    expect(githubStatusCategory("closed", "completed")).toBe("done");
    expect(githubStatusCategory("closed", null)).toBe("done");
    expect(githubStatusCategory("closed", "not_planned")).toBe("canceled");
    expect(githubStatusCategory("closed", "duplicate")).toBe("canceled");
    expect(githubStatusName("closed", "not_planned")).toBe("Closed as not planned");
    expect(githubStatusName("open", "reopened")).toBe("Open");
  });

  it("knows its own vocabulary", () => {
    expect(isIssueStatusCategory("in_progress")).toBe(true);
    expect(isIssueStatusCategory("doing")).toBe(false);
    expect(isIssueStatusClosed("canceled")).toBe(true);
    expect(isIssueStatusClosed("todo")).toBe(false);
  });
});

describe("transitions", () => {
  const unknown = { status: null, statusCategory: null };
  const todo = { status: "To Do", statusCategory: "todo" as const };
  const doing = { status: "In Progress", statusCategory: "in_progress" as const };
  const done = { status: "Done", statusCategory: "done" as const };

  it("treats the first reading as a baseline, not a change", () => {
    expect(issueStatusChanged(unknown, done)).toBe(false);
    expect(issueBecameDone(unknown, done)).toBe(false);
  });

  it("notices a moved status, including a renamed one in the same category", () => {
    expect(issueStatusChanged(todo, doing)).toBe(true);
    expect(issueStatusChanged(doing, { ...doing, status: "In Review" })).toBe(true);
    expect(issueStatusChanged(doing, doing)).toBe(false);
  });

  it("only counts a move into done once", () => {
    expect(issueBecameDone(doing, done)).toBe(true);
    expect(issueBecameDone(done, done)).toBe(false);
    expect(issueBecameDone(doing, { statusCategory: "canceled" })).toBe(false);
  });

  it("never lets an older reading overwrite a newer one", () => {
    expect(isIssueReadingFresh("2026-10-16T10:00:00Z", "2026-10-16T09:59:59Z")).toBe(false);
    expect(isIssueReadingFresh("2026-10-16T10:00:00Z", "2026-10-16T10:00:00Z")).toBe(true);
    expect(isIssueReadingFresh(new Date("2026-10-16T10:00:00Z"), "2026-10-16T11:00:00Z")).toBe(
      true,
    );
    // Nothing to compare: accept.
    expect(isIssueReadingFresh(null, "2026-10-16T10:00:00Z")).toBe(true);
    expect(isIssueReadingFresh("2026-10-16T10:00:00Z", null)).toBe(true);
  });

  it("names issues the way each tracker does", () => {
    expect(issueHandle({ tracker: "jira", issueKey: "OPS-412" })).toBe("OPS-412");
    expect(issueHandle({ tracker: "linear", issueIdentifier: "ENG-1" })).toBe("ENG-1");
    expect(issueHandle({ tracker: "github", repo: "acme/infra", issueNumber: 12 })).toBe(
      "acme/infra#12",
    );
  });
});

describe("budget alerts as an issue source", () => {
  it("is a source kind every tracker accepts", () => {
    expect(JIRA_SOURCE_KINDS).toContain("budget_alert");
    expect(GITHUB_ISSUE_SOURCE_KINDS).toContain("budget_alert");
    expect(jiraSourceKindLabel("budget_alert")).toBe("Budget alert");
    expect(githubSourceKindLabel("budget_alert")).toBe("Budget alert");
  });

  const budget: BudgetWithStatus = {
    id: "bud-1",
    name: "Production AWS",
    amountCents: 10_000_00,
    currency: "USD",
    filters: [
      { dimension: "provider", op: "in", values: ["aws"] },
      { dimension: "tag", tagKey: "env", op: "not_in", values: ["dev", "test"] },
    ],
    thresholds: [{ type: "actual", percent: 80 }],
    month: "2026-10",
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    actualCents: 8_120_00,
    forecastCents: 12_400_00,
    currentMonthEvents: [
      {
        id: "evt-1",
        thresholdType: "actual",
        thresholdPercent: 80,
        triggeredAt: "2026-10-14T06:00:00.000Z",
        note: {
          text: "Load test this week",
          notedAt: "2026-10-14T07:00:00.000Z",
          notedByUserId: "u1",
          notedByName: "Sam",
          annotationId: null,
        },
      },
    ],
    placements: [],
  } as BudgetWithStatus;
  const event = budget.currentMonthEvents[0]!;

  it("describes scope filters compactly", () => {
    expect(describeBudgetFilter(budget.filters[0]!)).toBe("provider in (aws)");
    expect(describeBudgetFilter(budget.filters[1]!)).toBe("tag env not in (dev, test)");
    expect(
      describeBudgetFilter({
        dimension: "service",
        op: "in",
        values: ["a", "b", "c", "d", "e", "f"],
      }),
    ).toBe("service in (a, b, c, d, e +1)");
  });

  it("states where spend stands against the limit now", () => {
    const facts = budgetAlertIssueFacts(budget, event);
    expect(facts).toMatchObject({
      budgetName: "Production AWS",
      forecastThreshold: false,
      thresholdPercent: 80,
      firedDay: "2026-10-14",
      spentPercent: 81,
      forecastPercent: 124,
      scope: "provider in (aws); tag env not in (dev, test)",
      firingNote: "Load test this week",
      rolledUpChildren: null,
    });
    expect(facts.limit).not.toBeNull();
  });

  it("builds a draft that reads on its own in a tracker", () => {
    const draft = buildJiraIssueDraft({
      sourceKind: "budget_alert",
      ...budgetAlertIssueDraft(budget, event, { appUrl: "https://app.example/budgets/bud-1" }),
    });
    expect(draft.summary).toMatch(/^Budget alert: "Production AWS" passed 80% of its budget/);
    expect(draft.description).toContain("Spend so far: ");
    expect(draft.description).toContain("(81%)");
    expect(draft.description).toContain("Note on this alert: Load test this week");
    expect(draft.description).toContain("View in Infrawrench: https://app.example/budgets/bud-1");
    expect(draft.labels).toEqual(["infrawrench", "budget-alert"]);
  });

  it("says when the threshold was a forecast", () => {
    const draft = budgetAlertIssueDraft(budget, { ...event, thresholdType: "forecast" });
    expect(draft.title).toContain("is forecast to reach 80%");
  });
});
