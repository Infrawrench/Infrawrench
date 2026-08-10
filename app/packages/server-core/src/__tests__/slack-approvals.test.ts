import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The shared halves of interactive Slack approvals: the button `value` a click
 * echoes back (which must round-trip and refuse anything malformed — it is
 * attacker-adjacent input on a public endpoint), and the post-decision update
 * that retires every recorded copy of a request.
 */

vi.mock("../db/schema", () => ({
  slackApprovalMessages: {
    __t: "slackApprovalMessages",
    organizationId: "organizationId",
    kind: "kind",
    approvalId: "approvalId",
  },
  workflowApprovals: {
    __t: "workflowApprovals",
    id: "id",
    status: "status",
    decidedByName: "decidedByName",
  },
  chatPendingActions: { __t: "chatPendingActions", id: "id", status: "status" },
}));

let messageRows: unknown[] = [];
/** The approval rows the post-insert reconciliation reads back. */
const approvalRows: Record<string, unknown[]> = {};
const insertedValues: unknown[][] = [];

vi.mock("../db/client", () => {
  const chain = (rows: () => unknown[]) => {
    const self: Record<string, unknown> = {};
    self["where"] = () => self;
    self["limit"] = () => Promise.resolve(rows());
    self["then"] = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(res, rej);
    return self;
  };
  return {
    db: {
      select: () => ({
        from: (table: { __t: string }) =>
          chain(() =>
            table.__t === "slackApprovalMessages" ? messageRows : (approvalRows[table.__t] ?? []),
          ),
      }),
      insert: () => ({
        values: (v: unknown[]) => {
          insertedValues.push(v);
          return Promise.resolve();
        },
      }),
    },
  };
});

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));

const loadOrgSlackTokens = vi.fn();
const updateSlackMessage = vi.fn();
const postSlackThreadReply = vi.fn();
vi.mock("../slack", () => ({
  escapeMrkdwn: (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  loadOrgSlackTokens: (...a: unknown[]) => loadOrgSlackTokens(...a),
  updateSlackMessage: (...a: unknown[]) => updateSlackMessage(...a),
  postSlackThreadReply: (...a: unknown[]) => postSlackThreadReply(...a),
}));

import {
  parseSlackApprovalButtonValue,
  recordSlackApprovalMessages,
  slackApprovalButtons,
  updateSlackApprovalMessages,
} from "../slack-approvals";

beforeEach(() => {
  vi.clearAllMocks();
  messageRows = [];
  for (const key of Object.keys(approvalRows)) delete approvalRows[key];
  // Default: the approval is still open, so recording does not reconcile.
  approvalRows["workflowApprovals"] = [{ status: "pending", decidedByName: null }];
  approvalRows["chatPendingActions"] = [{ status: "pending" }];
  insertedValues.length = 0;
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
    expect(insertedValues).toHaveLength(0);
  });

  it("stores one row per delivered message", async () => {
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
    expect(insertedValues[0]).toHaveLength(2);
    expect(insertedValues[0]![0]).toMatchObject({
      organizationId: "org-1",
      kind: "chat",
      approvalId: "pa-1",
      channelId: "C1",
      messageTs: "1.1",
    });
  });

  it("leaves an open approval's fresh copies alone", async () => {
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
    approvalRows["workflowApprovals"] = [{ status: "approved", decidedByName: "Astrid" }];
    messageRows = [{ installationId: "inst1", channelId: "C1", messageTs: "1.1" }];
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
    approvalRows["chatPendingActions"] = [{ status: "rejected" }];
    messageRows = [{ installationId: "inst1", channelId: "C1", messageTs: "1.1" }];
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
    approvalRows["chatPendingActions"] = [{ status: "approved" }];
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
    messageRows = [
      { installationId: "inst1", channelId: "C1", messageTs: "1.1" },
      { installationId: "inst1", channelId: "C2", messageTs: "2.2" },
    ];
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
    messageRows = [{ installationId: "gone", channelId: "C1", messageTs: "1.1" }];
    await updateSlackApprovalMessages("org-1", "workflow", "ap-1", OUTCOME);
    expect(updateSlackMessage).not.toHaveBeenCalled();
  });

  it("never throws when Slack errors — the decision is already landed", async () => {
    messageRows = [{ installationId: "inst1", channelId: "C1", messageTs: "1.1" }];
    updateSlackMessage.mockRejectedValue(new Error("channel_not_found"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      updateSlackApprovalMessages("org-1", "workflow", "ap-1", OUTCOME),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("says who denied when the decision was a denial from the web", async () => {
    messageRows = [{ installationId: "inst1", channelId: "C1", messageTs: "1.1" }];
    await updateSlackApprovalMessages("org-1", "chat", "pa-1", {
      ...OUTCOME,
      decision: "denied",
      via: "the web app",
    });
    const text = updateSlackMessage.mock.calls[0]![3] as string;
    expect(text).toContain("Denied by Astrid via the web app");
  });

  it("renders a timeout as expired with no decider", async () => {
    messageRows = [{ installationId: "inst1", channelId: "C1", messageTs: "1.1" }];
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
    messageRows = [{ installationId: "inst1", channelId: "C1", messageTs: "1.1" }];
    await updateSlackApprovalMessages("org-1", "workflow", "ap-1", {
      ...OUTCOME,
      decision: "expired",
    });
    const text = updateSlackMessage.mock.calls[0]![3] as string;
    expect(text).toContain("Expired");
    expect(text).toContain("Astrid's approval via Slack came after the timeout");
  });
});
