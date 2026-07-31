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
 *  - a transport outage cannot fail the run that is waiting.
 */

vi.mock("../db/schema", () => ({
  workflowApprovals: { __t: "workflowApprovals", id: "id", status: "status" },
  workflows: { __t: "workflows", id: "id", name: "name" },
}));

/** The row the poll loop reads back. */
let approvalRow: Record<string, unknown> | undefined;

vi.mock("../db/client", () => {
  const selectChain = () => {
    const self: Record<string, unknown> = {};
    for (const m of ["from", "where", "leftJoin", "orderBy"]) self[m] = () => self;
    self["limit"] = () => Promise.resolve(approvalRow ? [approvalRow] : []);
    return self;
  };
  const updateChain = () => {
    const self: Record<string, unknown> = {};
    self["set"] = () => self;
    self["where"] = () => Promise.resolve(undefined);
    return self;
  };
  return {
    db: {
      select: () => selectChain(),
      insert: () => ({ values: () => Promise.resolve(undefined) }),
      update: () => updateChain(),
    },
  };
});

vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ and: parts }),
  desc: (c: unknown) => ({ desc: c }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));

const sendPushToOrg = vi.fn();
const sendSlackToOrg = vi.fn();
const sendMsTeamsToOrg = vi.fn();
const sendOneShotPage = vi.fn();
vi.mock("../push/dispatch", () => ({ sendPushToOrg: (...a: unknown[]) => sendPushToOrg(...a) }));
vi.mock("../slack", () => ({ sendSlackToOrg: (...a: unknown[]) => sendSlackToOrg(...a) }));
vi.mock("../msteams", () => ({ sendMsTeamsToOrg: (...a: unknown[]) => sendMsTeamsToOrg(...a) }));
vi.mock("../twilio-pager", () => ({ sendOneShotPage: (...a: unknown[]) => sendOneShotPage(...a) }));

import { requestApprovalAndWait } from "../workflows/approvals";

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
  approvalRow = { status: "approved", decidedByName: "Astrid", decidedAt: new Date() };
  sendPushToOrg.mockResolvedValue({ attempted: 1, succeeded: 1 });
  sendSlackToOrg.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 });
  sendMsTeamsToOrg.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 });
  sendOneShotPage.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 });
  process.env["APP_URL"] = "https://app.example.com";
});

afterEach(() => {
  delete process.env["APP_URL"];
});

describe("approval request fan-out", () => {
  it("notifies every transport under the workflowPages trigger", async () => {
    await requestApprovalAndWait(CTX, SPEC);
    expect(sendPushToOrg).toHaveBeenCalledWith(ORG, "workflowPages", expect.anything());
    expect(sendSlackToOrg).toHaveBeenCalledWith(ORG, "workflowPages", expect.anything());
    expect(sendMsTeamsToOrg).toHaveBeenCalledWith(ORG, "workflowPages", expect.anything());
    expect(sendOneShotPage).toHaveBeenCalledTimes(1);
  });

  it("carries what is needed to decide without opening the app", async () => {
    await requestApprovalAndWait(CTX, SPEC);
    const teams = sendMsTeamsToOrg.mock.calls[0]![2] as {
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
    const slack = sendSlackToOrg.mock.calls[0]![2] as { title: string };
    expect(slack.title).toBe("Approval needed: Deploy v42 to production");
  });

  it("says a person started it when the run was manual", async () => {
    await requestApprovalAndWait({ ...CTX, triggerSource: "manual" }, SPEC);
    const teams = sendMsTeamsToOrg.mock.calls[0]![2] as { body: string };
    expect(teams.body).toContain("started manually by a team member");
  });

  it("gives Slack mrkdwn and Teams plain text", async () => {
    await requestApprovalAndWait(CTX, SPEC);
    const slack = sendSlackToOrg.mock.calls[0]![2] as { body: string };
    const teams = sendMsTeamsToOrg.mock.calls[0]![2] as { body: string };
    expect(slack.body).toContain("*prod-deploy*");
    expect(teams.body).not.toContain("*");
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
    const slack = sendSlackToOrg.mock.calls[0]![2] as { url?: string };
    expect(slack.url).toBeUndefined();
  });

  it("refuses to raise an approval outside a persisted run", async () => {
    const { runId: _runId, ...noRun } = CTX;
    await expect(requestApprovalAndWait(noRun, SPEC)).rejects.toThrow(/persisted workflow run/);
    expect(sendSlackToOrg).not.toHaveBeenCalled();
  });

  it("still waits for the decision when a transport throws", async () => {
    // The transports swallow their own errors in production; if one ever
    // leaks, the run must not fail on it — the request is already recorded and
    // the inbox can decide it whether or not anyone was told.
    sendMsTeamsToOrg.mockRejectedValue(new Error("teams exploded"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(requestApprovalAndWait(CTX, SPEC)).resolves.toMatchObject({ approved: true });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
