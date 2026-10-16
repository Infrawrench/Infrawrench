import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  githubReadingFromIssue,
  jiraReadingFromIssue,
  linearReadingFromIssue,
  normalizeTimestamp,
  parseGithubWebhook,
  parseJiraWebhook,
  parseLinearWebhook,
  verifyHubSignature,
  verifyLinearSignature,
} from "../issue-status/readings";
import { planIssueStatusUpdate } from "../issue-status/plan";
import { issueDoneExplanation } from "../issue-status/acknowledge";

// Not a real credential: a fixed string so the HMACs below are reproducible.
const SECRET = "test-webhook-secret-not-real";

function hubSignature(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

describe("webhook signatures", () => {
  const body = JSON.stringify({ webhookEvent: "jira:issue_updated" });

  it("accepts the sha256= HMAC GitHub and Jira send", () => {
    expect(verifyHubSignature(SECRET, body, hubSignature(body))).toBe(true);
    expect(
      verifyHubSignature(
        SECRET,
        body,
        hubSignature(body).toUpperCase().replace("SHA256", "sha256"),
      ),
    ).toBe(true);
  });

  it("refuses a wrong secret, a tampered body, a missing or legacy header", () => {
    expect(verifyHubSignature(SECRET, body, hubSignature(body, "other"))).toBe(false);
    expect(verifyHubSignature(SECRET, `${body} `, hubSignature(body))).toBe(false);
    expect(verifyHubSignature(SECRET, body, undefined)).toBe(false);
    expect(verifyHubSignature(SECRET, body, "sha1=abc")).toBe(false);
    expect(verifyHubSignature("", body, hubSignature(body, ""))).toBe(false);
  });

  it("checks Linear's bare hex signature and its one-minute replay window", () => {
    const now = Date.parse("2026-10-16T10:00:00Z");
    const payload = JSON.stringify({ type: "Issue", webhookTimestamp: now - 5_000 });
    const sig = createHmac("sha256", SECRET).update(payload).digest("hex");
    expect(verifyLinearSignature(SECRET, payload, sig, now - 5_000, now)).toBe(true);
    expect(verifyLinearSignature(SECRET, payload, sig, now - 61_000, now)).toBe(false);
    expect(verifyLinearSignature(SECRET, payload, sig, "not a number", now)).toBe(false);
    expect(verifyLinearSignature(SECRET, payload, `sha256=${sig}`, now, now)).toBe(false);
    expect(verifyLinearSignature("other", payload, sig, now, now)).toBe(false);
  });
});

describe("readings", () => {
  it("reads a Jira issue bean", () => {
    expect(
      jiraReadingFromIssue({
        id: "10042",
        key: "OPS-412",
        fields: {
          status: { name: "In Review", statusCategory: { key: "indeterminate" } },
          assignee: { displayName: "Sam Lee" },
          updated: "2026-10-16T09:12:44.123+0000",
        },
      }),
    ).toEqual({
      issueId: "10042",
      issueKey: "OPS-412",
      status: "In Review",
      statusCategory: "in_progress",
      assignee: "Sam Lee",
      issueUpdatedAt: "2026-10-16T09:12:44.123Z",
    });
    expect(jiraReadingFromIssue({ fields: {} })).toBeNull();
  });

  it("reads a Linear issue node, preferring the display name", () => {
    expect(
      linearReadingFromIssue({
        id: "uuid-1",
        identifier: "ENG-7",
        url: "https://linear.app/acme/issue/ENG-7",
        updatedAt: "2026-10-16T09:00:00.000Z",
        state: { name: "Backlog", type: "backlog" },
        assignee: { name: "sam", displayName: "Sam" },
      }),
    ).toMatchObject({
      issueId: "uuid-1",
      status: "Backlog",
      statusCategory: "todo",
      assignee: "Sam",
    });
  });

  it("reads a GitHub issue, with the first assignee's login", () => {
    expect(
      githubReadingFromIssue({
        number: 12,
        html_url: "https://github.com/acme/infra/issues/12",
        state: "closed",
        state_reason: "not_planned",
        assignees: [{ login: "octo" }, { login: "cat" }],
        updated_at: "2026-10-16T09:00:00Z",
      }),
    ).toMatchObject({
      number: 12,
      state: "closed",
      status: "Closed as not planned",
      statusCategory: "canceled",
      assignee: "octo",
    });
  });

  it("normalizes tracker timestamps", () => {
    expect(normalizeTimestamp("2026-10-16T09:12:44.000+0200")).toBe("2026-10-16T07:12:44.000Z");
    expect(normalizeTimestamp(1_760_000_000_000)).toBe(new Date(1_760_000_000_000).toISOString());
    expect(normalizeTimestamp("nonsense")).toBeNull();
  });
});

describe("webhook payloads", () => {
  it("parses Jira updates and deletes, ignoring everything else", () => {
    const issue = {
      id: "1",
      key: "OPS-1",
      fields: { status: { name: "Done", statusCategory: { key: "done" } } },
    };
    expect(parseJiraWebhook({ webhookEvent: "jira:issue_updated", issue })).toMatchObject({
      kind: "updated",
      reading: { issueKey: "OPS-1", statusCategory: "done" },
    });
    expect(parseJiraWebhook({ webhookEvent: "jira:issue_deleted", issue })).toEqual({
      kind: "deleted",
      issueId: "1",
      issueKey: "OPS-1",
    });
    expect(parseJiraWebhook({ webhookEvent: "comment_created", issue })).toEqual({
      kind: "ignored",
    });
    expect(parseJiraWebhook(null)).toEqual({ kind: "ignored" });
  });

  it("parses Linear issue events and flags a payload without a nested state", () => {
    const data = { id: "u1", identifier: "ENG-1", state: { name: "Done", type: "completed" } };
    expect(parseLinearWebhook({ type: "Issue", action: "update", data })).toMatchObject({
      kind: "updated",
      complete: true,
      reading: { statusCategory: "done" },
    });
    expect(
      parseLinearWebhook({
        type: "Issue",
        action: "update",
        data: { id: "u1", identifier: "ENG-1", stateId: "s" },
      }),
    ).toMatchObject({ kind: "updated", complete: false });
    expect(parseLinearWebhook({ type: "Issue", action: "remove", data })).toEqual({
      kind: "deleted",
      issueId: "u1",
      identifier: "ENG-1",
    });
    expect(parseLinearWebhook({ type: "Comment", action: "create", data })).toEqual({
      kind: "ignored",
    });
  });

  it("parses GitHub App issues events and never treats a pull request as one", () => {
    const base = { installation: { id: 7 }, repository: { full_name: "acme/infra" } };
    expect(
      parseGithubWebhook("issues", {
        ...base,
        action: "closed",
        issue: { number: 12, state: "closed", state_reason: "completed", assignees: [] },
      }),
    ).toMatchObject({
      kind: "updated",
      installationId: 7,
      repo: "acme/infra",
      reading: { statusCategory: "done" },
    });
    expect(
      parseGithubWebhook("issues", {
        ...base,
        action: "closed",
        issue: { number: 3, pull_request: {} },
      }),
    ).toEqual({ kind: "ignored" });
    expect(
      parseGithubWebhook("issues", {
        ...base,
        action: "transferred",
        issue: { number: 12 },
        changes: {
          new_issue: { number: 3, html_url: "https://github.com/acme/ops/issues/3" },
          new_repository: { full_name: "acme/ops" },
        },
      }),
    ).toMatchObject({ kind: "transferred", newRepo: "acme/ops", newNumber: 3 });
    expect(
      parseGithubWebhook("issues", { ...base, action: "deleted", issue: { number: 12 } }),
    ).toEqual({
      kind: "deleted",
      installationId: 7,
      repo: "acme/infra",
      number: 12,
    });
    expect(parseGithubWebhook("push", { ...base })).toEqual({ kind: "ignored" });
    expect(
      parseGithubWebhook("issues", { ...base, action: "labeled", issue: { number: 1 } }),
    ).toEqual({
      kind: "ignored",
    });
  });
});

describe("planIssueStatusUpdate", () => {
  const stored = {
    status: "In Progress",
    statusCategory: "in_progress",
    assignee: "Sam",
    issueUpdatedAt: new Date("2026-10-16T09:00:00.000Z"),
  };

  it("applies a newer reading and reports the move to done", () => {
    const plan = planIssueStatusUpdate(stored, {
      status: "Done",
      statusCategory: "done",
      assignee: "Sam",
      issueUpdatedAt: "2026-10-16T10:00:00.000Z",
    });
    expect(plan).toMatchObject({ fresh: true, changed: true, becameDone: true, differs: true });
    expect(plan.previous).toEqual({ status: "In Progress", statusCategory: "in_progress" });
  });

  it("ignores an older reading entirely", () => {
    expect(
      planIssueStatusUpdate(stored, {
        status: "To Do",
        statusCategory: "todo",
        assignee: null,
        issueUpdatedAt: "2026-10-16T08:00:00.000Z",
      }),
    ).toMatchObject({ fresh: false, changed: false, becameDone: false, differs: false });
  });

  it("records an assignee change without calling it a status change", () => {
    expect(
      planIssueStatusUpdate(stored, {
        status: "In Progress",
        statusCategory: "in_progress",
        assignee: "Alex",
        issueUpdatedAt: "2026-10-16T09:30:00.000Z",
      }),
    ).toMatchObject({ fresh: true, changed: false, becameDone: false, differs: true });
  });

  it("baselines the first reading silently", () => {
    expect(
      planIssueStatusUpdate(
        { status: null, statusCategory: null, assignee: null, issueUpdatedAt: null },
        { status: "Done", statusCategory: "done", assignee: null, issueUpdatedAt: null },
      ),
    ).toMatchObject({ fresh: true, changed: false, becameDone: false, differs: true });
  });
});

describe("issueDoneExplanation", () => {
  it("names the tracker, the issue and its status", () => {
    expect(issueDoneExplanation("Jira", "OPS-412", "Done")).toBe(
      "Resolved in Jira as OPS-412 (Done).",
    );
    expect(issueDoneExplanation("GitHub", "acme/infra#12", null)).toBe(
      "Resolved in GitHub as acme/infra#12.",
    );
  });
});
