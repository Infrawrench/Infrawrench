import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Approval-request fan-out. `requestApprovalAndWait` blocks until a decision
 * lands, so these tests approve on the first poll and assert what went out
 * before the wait — the notification is the part this change added.
 *
 * What matters:
 *  - every transport the org has configured is used, all under the existing
 *    `workflowPages` opt-in;
 *  - the message carries enough to act on without opening the app: what is
 *    being approved, the workflow and run, who asked, when it expires;
 *  - Slack gets mrkdwn, Teams gets plain text (its card escaper would show a
 *    literal asterisk), SMS gets one short line;
 *  - the SMS leg — and only that leg — is damped by a per-workflow cooldown, so
 *    a workflow raising approvals in a loop cannot text everybody N times;
 *  - a transport outage cannot fail the run that is waiting.
 */

import { fakePostgres } from "./helpers/fake-postgres";

// Real Drizzle over a recording driver against the real schema — the approval
// insert and the poll loop's read-back render their actual SQL (and
// shadow-validate under test:postgres:shadow). Every test decides on the first
// poll, so the default rows are the approved row the loop reads back.
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

/**
 * The row the poll loop reads back — keys in workflow_approvals column order,
 * values driver-shaped (timestamps as Postgres text). See
 * helpers/fake-postgres.ts.
 */
function approvedRow(): Record<string, unknown> {
  return {
    id: "appr-1",
    organizationId: ORG,
    workflowId: "wf1",
    runId: "run-7",
    title: "prod-deploy",
    message: "Roll the API to v42?",
    status: "approved",
    expiresAt: "2026-08-14 12:00:00.000",
    decidedAt: "2026-08-14 11:00:00.000",
    decidedByUserId: "u1",
    decidedByName: "Astrid",
    createdAt: "2026-08-14 10:00:00.000",
  };
}

const sendOneShotPage = vi.fn();
const recordSlackApprovalMessages = vi.fn();
const updateSlackApprovalMessages = vi.fn();
vi.mock("../slack-approvals", () => ({
  // Real-shaped buttons so the test can assert what the Slack message carries.
  slackApprovalButtons: (v: { kind: string; approvalId: string; organizationId: string }) => [
    {
      text: "Approve",
      actionId: "infrawrench_approval_approve",
      value: JSON.stringify({ k: v.kind, a: v.approvalId, o: v.organizationId }),
      style: "primary",
    },
    {
      text: "Deny",
      actionId: "infrawrench_approval_deny",
      value: JSON.stringify({ k: v.kind, a: v.approvalId, o: v.organizationId }),
      style: "danger",
    },
  ],
  recordSlackApprovalMessages: (...a: unknown[]) => recordSlackApprovalMessages(...a),
  updateSlackApprovalMessages: (...a: unknown[]) => updateSlackApprovalMessages(...a),
}));
vi.mock("../twilio-pager", () => ({ sendOneShotPage: (...a: unknown[]) => sendOneShotPage(...a) }));

/** The `workflow_pages` cooldown row the SMS leg claims. */
const pageStore = {
  read: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
};
const workflowPageCooldownStore = vi.fn((..._a: unknown[]) => pageStore);
vi.mock("../workflows/paging", () => ({
  workflowPageCooldownStore: (...a: unknown[]) => workflowPageCooldownStore(...a),
}));

/**
 * All three transports sit behind `routeAlert` now, so that is the single seam
 * these tests mock. `alertReached` is the real predicate rather than a stub —
 * it decides whether a cooldown or claim is kept, and faking it would hide
 * exactly the bug it exists to prevent.
 */
// Defaults to a successful delivery: `routeAlert` never throws and always
// returns a result, so a mock that resolves `undefined` would fail tests in a
// way the real function cannot.
const routeAlert = vi.fn(async (..._args: unknown[]) => routed());
vi.mock("../alerts/route", () => ({
  routeAlert: (...a: unknown[]) => routeAlert(...a),
  alertReached: (r: { succeeded?: number; held?: number } | null | undefined) =>
    (r?.succeeded ?? 0) > 0 || (r?.held ?? 0) > 0,
}));

/** A delivery that reached one Slack channel and one phone. */
function routed(over: Record<string, unknown> = {}) {
  return {
    attempted: 2,
    succeeded: 2,
    byTransport: { push: 1, slack: 1, msTeams: 0 },
    attemptedByTransport: { push: 1, slack: 1, msTeams: 0 },
    held: 0,
    unrouted: false,
    matchedRuleIds: ["rule1"],
    // The tracked-Slack half of the result. Present by default because
    // `byTransport.slack` is 1 — a result claiming a Slack delivery with no
    // message to show for it is a shape the real function never returns.
    slackMessages: [{ installationId: "inst1", channelId: "C1", ts: "1722700000.000100" }],
    deliveryIds: [],
    ...over,
  };
}

/** A delivery that reached nobody — no rule matched, or every channel failed. */
function unroutedResult() {
  return routed({
    attempted: 0,
    succeeded: 0,
    byTransport: { push: 0, slack: 0, msTeams: 0 },
    attemptedByTransport: { push: 0, slack: 0, msTeams: 0 },
    matchedRuleIds: [],
    slackMessages: [],
    unrouted: true,
  });
}

const { requestApprovalAndWait } = await import("../workflows/approvals");

const ORG = "org1";

const CTX = {
  organizationId: ORG,
  workflowId: "wf1",
  workflowName: "prod-deploy",
  runId: "run-7",
  triggerSource: "cron",
};

const SPEC = { message: "Roll the API to v42?", timeoutMinutes: 30 };

beforeEach(() => {
  vi.clearAllMocks();
  pg.reset();
  pg.setRows([approvedRow()]);
  routeAlert.mockResolvedValue(routed());
  sendOneShotPage.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 });
  workflowPageCooldownStore.mockReturnValue(pageStore);
  // No row for the key yet: the claim is an insert, which always wins.
  pageStore.read.mockResolvedValue(null);
  pageStore.claim.mockResolvedValue(true);
  pageStore.release.mockResolvedValue(undefined);
  process.env["APP_URL"] = "https://app.example.com";
});

afterEach(() => {
  delete process.env["APP_URL"];
});

describe("approval request fan-out", () => {
  it("routes under the workflowPages trigger, tracked and never held", async () => {
    await requestApprovalAndWait(CTX, SPEC);
    expect(routeAlert).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "workflowPages" }),
      // Tracked because a decision has to retire every posted copy, and
      // quiet-hours-exempt because no decision counts as a denial — holding an
      // approval until morning would silently deny the run.
      expect.objectContaining({ track: true, bypassQuietHours: true }),
    );
    expect(sendOneShotPage).toHaveBeenCalledTimes(1);
  });

  it("carries what is needed to decide without opening the app", async () => {
    await requestApprovalAndWait(CTX, SPEC);
    const teams = routeAlert.mock.calls[0]![0] as {
      title: string;
      body: string;
      context: string;
      url?: string;
    };
    expect(teams.title).toBe("Approval needed: prod-deploy");
    expect(teams.body).toContain("Roll the API to v42?");
    expect(teams.body).toContain("Workflow: prod-deploy · run run-7");
    expect(teams.body).toContain("started on its schedule");
    expect(teams.body).toContain("expires in 30 minutes");
    expect(teams.body).toContain("no decision counts as a denial");
    expect(teams.context).toContain("run run-7");
    expect(teams.url).toBe(`https://app.example.com/org/${ORG}/settings/approvals`);
  });

  it("uses the spec's title when the author set one", async () => {
    await requestApprovalAndWait(CTX, { ...SPEC, title: "Deploy v42 to production" });
    const slack = routeAlert.mock.calls[0]![0] as { title: string };
    expect(slack.title).toBe("Approval needed: Deploy v42 to production");
  });

  it("says a person started it when the run was manual", async () => {
    await requestApprovalAndWait({ ...CTX, triggerSource: "manual" }, SPEC);
    const teams = routeAlert.mock.calls[0]![0] as { body: string };
    expect(teams.body).toContain("started manually by a team member");
  });

  it("puts Approve/Deny buttons on the Slack copy, valued for this approval", async () => {
    await requestApprovalAndWait(CTX, SPEC);
    const options = routeAlert.mock.calls[0]![1] as {
      slackButtons?: Array<{ actionId: string; value: string; style?: string }>;
    };
    expect(options.slackButtons).toHaveLength(2);
    const [approve, deny] = options.slackButtons!;
    expect(approve!.actionId).toBe("infrawrench_approval_approve");
    expect(deny!.actionId).toBe("infrawrench_approval_deny");
    const value = JSON.parse(approve!.value) as { k: string; a: string; o: string };
    expect(value.k).toBe("workflow");
    expect(value.o).toBe(ORG);
    // The value's approval id is the id the request was recorded under, so the
    // click decides this row and no other.
    expect(value.a).toBeTruthy();
  });

  it("records where the Slack copies landed so a decision can retire them", async () => {
    await requestApprovalAndWait(CTX, SPEC);
    expect(recordSlackApprovalMessages).toHaveBeenCalledWith(
      ORG,
      "workflow",
      expect.any(String),
      [{ installationId: "inst1", channelId: "C1", ts: "1722700000.000100" }],
      // The rendering the recorder falls back to if the request is already
      // decided by the time the refs land.
      { title: "Approval needed: prod-deploy", body: "Roll the API to v42?" },
    );
    // Same approval id as the buttons carry.
    const options = routeAlert.mock.calls[0]![1] as {
      slackButtons: Array<{ value: string }>;
    };
    const buttonValue = JSON.parse(options.slackButtons[0]!.value) as { a: string };
    expect(recordSlackApprovalMessages.mock.calls[0]![2]).toBe(buttonValue.a);
  });

  it("still resolves when recording the Slack message refs fails", async () => {
    recordSlackApprovalMessages.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(requestApprovalAndWait(CTX, SPEC)).resolves.toMatchObject({ approved: true });
    spy.mockRestore();
  });

  it("gives Slack mrkdwn and Teams plain text", async () => {
    await requestApprovalAndWait(CTX, SPEC);
    // One event, two renderings: `body` is Slack's, `teamsBody` overrides it
    // for the Adaptive Card, whose escaper would print a literal asterisk.
    const event = routeAlert.mock.calls[0]![0] as { body: string; teamsBody: string };
    expect(event.body).toContain("*prod-deploy*");
    expect(event.teamsBody).not.toContain("*");
  });

  it("sends one short SMS line, not the full detail block", async () => {
    await requestApprovalAndWait(CTX, SPEC);
    const [org, body] = sendOneShotPage.mock.calls[0]! as [string, string];
    expect(org).toBe(ORG);
    expect(body).toContain("infrawrench approval needed: prod-deploy");
    expect(body).toContain("Roll the API to v42?");
    expect(body).not.toContain("\n");
  });

  it("does not ring a phone — approvals are SMS-only", async () => {
    await requestApprovalAndWait(CTX, SPEC);
    const opts = sendOneShotPage.mock.calls[0]![2];
    expect(opts).toBeUndefined();
  });

  it("omits the button when the server has no APP_URL", async () => {
    delete process.env["APP_URL"];
    await requestApprovalAndWait(CTX, SPEC);
    const slack = routeAlert.mock.calls[0]![0] as { url?: string };
    expect(slack.url).toBeUndefined();
  });

  it("refuses to raise an approval outside a persisted run", async () => {
    const { runId: _runId, ...noRun } = CTX;
    await expect(requestApprovalAndWait(noRun, SPEC)).rejects.toThrow(/persisted workflow run/);
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("still waits for the decision when a transport throws", async () => {
    // The transports swallow their own errors in production; if one ever
    // leaks, the run must not fail on it — the request is already recorded and
    // the inbox can decide it whether or not anyone was told.
    routeAlert.mockResolvedValue(unroutedResult());
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(requestApprovalAndWait(CTX, SPEC)).resolves.toMatchObject({ approved: true });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

/**
 * The SMS cooldown. "One message per `waitForApproval` call" bounds nothing on
 * its own — `waitForApproval` is a call a workflow can make in a loop — so the
 * SMS leg claims a reserved `workflow_pages` key before it sends.
 *
 * The trade-off these tests pin down: damp a loop, never mute the first
 * request, and never let a suppressed *text* hide an approval — Slack, Teams
 * and push stay one-per-request because each approval is a separate decision
 * somebody has to go and make.
 */
describe("approval SMS cooldown", () => {
  it("throttles on a reserved key scoped to the workflow, not the run", async () => {
    // Per-workflow is what covers both flood shapes: one run looping over N
    // items, and a workflow that keeps being re-triggered.
    await requestApprovalAndWait(CTX, SPEC);
    expect(workflowPageCooldownStore).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, workflowId: "wf1" }),
      "__approval__",
    );
    expect(pageStore.claim).toHaveBeenCalledWith(
      expect.stringContaining("infrawrench approval needed"),
      15,
    );
  });

  it("lets the first request through — a blocked run must interrupt someone", async () => {
    await requestApprovalAndWait(CTX, SPEC);
    expect(sendOneShotPage).toHaveBeenCalledTimes(1);
    expect(pageStore.release).not.toHaveBeenCalled();
  });

  it("damps a loop: a request inside the window sends no SMS", async () => {
    pageStore.claim.mockResolvedValue(false);
    await requestApprovalAndWait(CTX, SPEC);
    expect(sendOneShotPage).not.toHaveBeenCalled();
  });

  it("still notifies Slack, Teams and push when the SMS is suppressed", async () => {
    // The cooldown damps the phone call, not the request. Collapsing these too
    // would leave a distinct pending approval with nothing pointing at it.
    pageStore.claim.mockResolvedValue(false);
    await requestApprovalAndWait(CTX, SPEC);
    expect(routeAlert).toHaveBeenCalledTimes(1);
  });

  it("does not mute a different workflow's approval", async () => {
    await requestApprovalAndWait(CTX, SPEC);
    await requestApprovalAndWait({ ...CTX, workflowId: "wf2", workflowName: "billing-run" }, SPEC);
    const scopes = workflowPageCooldownStore.mock.calls.map(
      (c) => (c as unknown[])[0] as { workflowId: string },
    );
    expect(scopes.map((s) => s.workflowId)).toEqual(["wf1", "wf2"]);
  });

  it("rolls the claim back when the SMS reached nobody", async () => {
    // An SMS nobody received must not start a quiet period — the same rule
    // paging/deliver.ts applies to a page.
    const prior = { lastPagedAt: new Date("2026-07-31T09:00:00.000Z") };
    pageStore.read.mockResolvedValue(prior);
    sendOneShotPage.mockResolvedValue({ attempted: 1, succeeded: 0, failed: 1 });

    await requestApprovalAndWait(CTX, SPEC);

    expect(pageStore.release).toHaveBeenCalledWith(prior);
  });

  it("keeps the claim when the SMS landed", async () => {
    await requestApprovalAndWait(CTX, SPEC);
    expect(pageStore.release).not.toHaveBeenCalled();
  });
});
