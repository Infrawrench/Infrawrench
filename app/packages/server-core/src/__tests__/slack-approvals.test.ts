import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The shared halves of interactive Slack approvals: the button `value` a click
 * echoes back (which must round-trip and refuse anything malformed — it is
 * attacker-adjacent input on a public endpoint), and the post-decision update
 * that retires every recorded copy of a request.
 */

import { fakePostgres } from "./helpers/fake-postgres";

// Real Drizzle over a recording driver against the real schema — the
// recorded-copy insert and the status/message selects render their actual SQL
// (and shadow-validate under test:postgres:shadow). Each test queues its
// results in execution order: the insert (result ignored), the approval-status
// read, then — only when the status came back decided — the message read-back.
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

/** The recorded-copy INSERT statements. */
const inserts = () =>
  pg.queries.filter((q) => q.sql.startsWith('insert into "slack_approval_messages"'));

/**
 * A recorded copy as the unprojected select returns it — keys in
 * slack_approval_messages column order (see helpers/fake-postgres.ts).
 */
function messageRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "sam-1",
    organizationId: "org-1",
    kind: "workflow",
    approvalId: "ap-1",
    installationId: "inst1",
    channelId: "C1",
    messageTs: "1.1",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

const loadOrgSlackTokens = vi.fn();
const updateSlackMessage = vi.fn();
const postSlackThreadReply = vi.fn();
vi.mock("../slack", () => ({
  escapeMrkdwn: (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  loadOrgSlackTokens: (...a: unknown[]) => loadOrgSlackTokens(...a),
  updateSlackMessage: (...a: unknown[]) => updateSlackMessage(...a),
  postSlackThreadReply: (...a: unknown[]) => postSlackThreadReply(...a),
}));

// Dynamic so the mocked `db/client` above is wired before the module loads.
const {
  parseSlackApprovalButtonValue,
  recordSlackApprovalMessages,
  slackApprovalButtons,
  updateSlackApprovalMessages,
} = await import("../slack-approvals");

beforeEach(() => {
  vi.clearAllMocks();
  pg.reset();
  loadOrgSlackTokens.mockResolvedValue(new Map([["inst1", "xoxb-1"]]));
  updateSlackMessage.mockResolvedValue(undefined);
  postSlackThreadReply.mockResolvedValue(undefined);
});

describe("approval button values", () => {
  it("round-trip through build and parse", () => {
    const [approve, deny] = slackApprovalButtons({
      kind: "workflow",
      approvalId: "ap-1",
      organizationId: "org-1",
    });
    expect(approve!.actionId).toBe("infrawrench_approval_approve");
    expect(deny!.actionId).toBe("infrawrench_approval_deny");
    for (const button of [approve!, deny!]) {
      expect(parseSlackApprovalButtonValue(button.value)).toEqual({
        kind: "workflow",
        approvalId: "ap-1",
        organizationId: "org-1",
      });
    }
  });

  it("refuses malformed or foreign values", () => {
    expect(parseSlackApprovalButtonValue(undefined)).toBeNull();
    expect(parseSlackApprovalButtonValue("not-json{")).toBeNull();
    expect(
      parseSlackApprovalButtonValue(JSON.stringify({ k: "other", a: "x", o: "y" })),
    ).toBeNull();
    expect(parseSlackApprovalButtonValue(JSON.stringify({ k: "chat", a: "", o: "y" }))).toBeNull();
  });
});

describe("recordSlackApprovalMessages", () => {
  const RENDERED = { title: "Approval needed: prod-deploy", body: "Roll the API to v42?" };

  it("skips the insert entirely when nothing was delivered", async () => {
    await recordSlackApprovalMessages("org-1", "workflow", "ap-1", [], RENDERED);
    expect(inserts()).toHaveLength(0);
  });

  it("stores one row per delivered message", async () => {
    pg.queueRows([]); // the insert itself
    pg.queueRows([{ status: "pending" }]); // the action is still open: no reconcile
    await recordSlackApprovalMessages(
      "org-1",
      "chat",
      "pa-1",
      [
        { installationId: "inst1", channelId: "C1", ts: "1.1" },
        { installationId: "inst1", channelId: "C2", ts: "2.2" },
      ],
      RENDERED,
    );
    // One INSERT with two value tuples of 7 bound values each (id, org, kind,
    // approvalId, installationId, channelId, messageTs; createdAt defaults).
    expect(inserts()).toHaveLength(1);
    const { params } = inserts()[0]!;
    expect(params).toHaveLength(14);
    expect(params.slice(1, 7)).toEqual(["org-1", "chat", "pa-1", "inst1", "C1", "1.1"]);
    expect(params.slice(8, 14)).toEqual(["org-1", "chat", "pa-1", "inst1", "C2", "2.2"]);
  });

  it("leaves an open approval's fresh copies alone", async () => {
    pg.queueRows([]); // the insert
    // Keys in projection order: status, decidedByName.
    pg.queueRows([{ status: "pending", decidedByName: null }]);
    await recordSlackApprovalMessages(
      "org-1",
      "workflow",
      "ap-1",
      [{ installationId: "inst1", channelId: "C1", ts: "1.1" }],
      RENDERED,
    );
    expect(updateSlackMessage).not.toHaveBeenCalled();
  });

  it("immediately retires copies recorded after the decision already landed", async () => {
    // The race: a decision lands while the Slack post is in flight, so its
    // updateSlackApprovalMessages ran before these rows existed. Recording
    // must notice the settled state and retire the fresh copies itself.
    pg.queueRows([]); // the insert
    pg.queueRows([{ status: "approved", decidedByName: "Astrid" }]);
    pg.queueRows([messageRow()]); // the recorded copies the retire pass reads back
    await recordSlackApprovalMessages(
      "org-1",
      "workflow",
      "ap-1",
      [{ installationId: "inst1", channelId: "C1", ts: "1.1" }],
      RENDERED,
    );
    expect(updateSlackMessage).toHaveBeenCalledTimes(1);
    const text = updateSlackMessage.mock.calls[0]![3] as string;
    expect(text).toContain("Approved by Astrid");
  });

  it("converges a chat action that was rejected mid-post to the denied form", async () => {
    pg.queueRows([]); // the insert
    pg.queueRows([{ status: "rejected" }]);
    pg.queueRows([messageRow({ kind: "chat", approvalId: "pa-1" })]);
    await recordSlackApprovalMessages(
      "org-1",
      "chat",
      "pa-1",
      [{ installationId: "inst1", channelId: "C1", ts: "1.1" }],
      RENDERED,
    );
    const text = updateSlackMessage.mock.calls[0]![3] as string;
    expect(text).toContain("Denied");
  });

  it("treats a claimed-but-still-executing chat action as open", async () => {
    // `approved` means a decider claimed it and execution is in flight; the
    // post-execution noteDecided call retires the copies once it settles.
    pg.queueRows([]); // the insert
    pg.queueRows([{ status: "approved" }]);
    await recordSlackApprovalMessages(
      "org-1",
      "chat",
      "pa-1",
      [{ installationId: "inst1", channelId: "C1", ts: "1.1" }],
      RENDERED,
    );
    expect(updateSlackMessage).not.toHaveBeenCalled();
  });
});

describe("updateSlackApprovalMessages", () => {
  const OUTCOME = {
    decision: "approved" as const,
    decidedByName: "Astrid",
    via: "Slack",
    title: "Approval needed: prod-deploy",
    body: "Roll the API to v42?",
  };

  it("rewrites every recorded copy without buttons and threads the outcome", async () => {
    pg.setRows([messageRow(), messageRow({ id: "sam-2", channelId: "C2", messageTs: "2.2" })]);
    await updateSlackApprovalMessages("org-1", "workflow", "ap-1", OUTCOME);

    expect(updateSlackMessage).toHaveBeenCalledTimes(2);
    const [token, channel, ts, text, blocks] = updateSlackMessage.mock.calls[0]! as [
      string,
      string,
      string,
      string,
      Array<{ type: string }>,
    ];
    expect([token, channel, ts]).toEqual(["xoxb-1", "C1", "1.1"]);
    expect(text).toContain("Approved by Astrid via Slack");
    // Buttons are gone: only the re-rendered body and the outcome context line.
    expect(blocks.map((b) => b.type)).toEqual(["section", "context"]);

    expect(postSlackThreadReply).toHaveBeenCalledWith(
      "xoxb-1",
      "C2",
      "2.2",
      expect.stringContaining("Approved by Astrid via Slack"),
    );
  });

  it("skips copies whose install has been disconnected", async () => {
    pg.setRows([messageRow({ installationId: "gone" })]);
    await updateSlackApprovalMessages("org-1", "workflow", "ap-1", OUTCOME);
    expect(updateSlackMessage).not.toHaveBeenCalled();
  });

  it("never throws when Slack errors — the decision is already landed", async () => {
    pg.setRows([messageRow()]);
    updateSlackMessage.mockRejectedValue(new Error("channel_not_found"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      updateSlackApprovalMessages("org-1", "workflow", "ap-1", OUTCOME),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("says who denied when the decision was a denial from the web", async () => {
    pg.setRows([messageRow({ kind: "chat", approvalId: "pa-1" })]);
    await updateSlackApprovalMessages("org-1", "chat", "pa-1", {
      ...OUTCOME,
      decision: "denied",
      via: "the web app",
    });
    const text = updateSlackMessage.mock.calls[0]![3] as string;
    expect(text).toContain("Denied by Astrid via the web app");
  });

  it("renders a timeout as expired with no decider", async () => {
    pg.setRows([messageRow()]);
    await updateSlackApprovalMessages("org-1", "workflow", "ap-1", {
      ...OUTCOME,
      decision: "expired",
      decidedByName: null,
    });
    const text = updateSlackMessage.mock.calls[0]![3] as string;
    expect(text).toContain("Expired — not decided within the timeout");
    expect(text).not.toContain("Astrid");
  });

  it("names the late decider when an approval landed after the timeout", async () => {
    pg.setRows([messageRow()]);
    await updateSlackApprovalMessages("org-1", "workflow", "ap-1", {
      ...OUTCOME,
      decision: "expired",
    });
    const text = updateSlackMessage.mock.calls[0]![3] as string;
    expect(text).toContain("Expired");
    expect(text).toContain("Astrid's approval via Slack came after the timeout");
  });
});
