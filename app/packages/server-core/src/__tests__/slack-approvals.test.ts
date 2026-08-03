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
}));

let messageRows: unknown[] = [];
const insertedValues: unknown[][] = [];

vi.mock("../db/client", () => {
  const chain = () => {
    const self: Record<string, unknown> = {};
    self["where"] = () => Promise.resolve(messageRows);
    return self;
  };
  return {
    db: {
      select: () => ({ from: () => chain() }),
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
  it("skips the insert entirely when nothing was delivered", async () => {
    await recordSlackApprovalMessages("org-1", "workflow", "ap-1", []);
    expect(insertedValues).toHaveLength(0);
  });

  it("stores one row per delivered message", async () => {
    await recordSlackApprovalMessages("org-1", "chat", "pa-1", [
      { installationId: "inst1", channelId: "C1", ts: "1.1" },
      { installationId: "inst1", channelId: "C2", ts: "2.2" },
    ]);
    expect(insertedValues[0]).toHaveLength(2);
    expect(insertedValues[0]![0]).toMatchObject({
      organizationId: "org-1",
      kind: "chat",
      approvalId: "pa-1",
      channelId: "C1",
      messageTs: "1.1",
    });
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
});
