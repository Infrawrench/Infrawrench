import { beforeEach, describe, expect, it, vi } from "vitest";

const loadOrgSlackTokens = vi.fn();
const postSlackThreadReply = vi.fn();
vi.mock("../slack", () => ({
  loadOrgSlackTokens: (...a: unknown[]) => loadOrgSlackTokens(...a),
  postSlackThreadReply: (...a: unknown[]) => postSlackThreadReply(...a),
}));

const sendMsTeamsToWebhooks = vi.fn();
vi.mock("../msteams", () => ({
  sendMsTeamsToWebhooks: (...a: unknown[]) => sendMsTeamsToWebhooks(...a),
}));

const { BudgetAlertNoteError, planBudgetAlertNote, postBudgetAlertNoteFollowUp } =
  await import("../cost/budget-alert-note");

const FIRED = new Date("2026-10-03T14:05:00.000Z");

describe("planBudgetAlertNote", () => {
  it("mints an org-wide note on the day the alert fired, the first time", () => {
    expect(
      planBudgetAlertNote(
        { triggeredAt: FIRED, notedAt: null, annotationId: null },
        "  Load test ",
      ),
    ).toEqual({
      action: "create",
      input: { startDate: "2026-10-03", endDate: null, text: "Load test", costReportId: null },
    });
  });

  it("rewords the marker it already made, text only", () => {
    expect(
      planBudgetAlertNote(
        { triggeredAt: FIRED, notedAt: FIRED, annotationId: "ann1" },
        "Load test, ends Friday",
      ),
    ).toEqual({ action: "update", annotationId: "ann1", text: "Load test, ends Friday" });
  });

  it("does not recreate a marker somebody deleted", () => {
    expect(
      planBudgetAlertNote({ triggeredAt: FIRED, notedAt: FIRED, annotationId: null }, "Again"),
    ).toEqual({ action: "none", reason: "annotation-deleted" });
  });

  it("refuses an empty or over-long note", () => {
    const event = { triggeredAt: FIRED, notedAt: null, annotationId: null };
    expect(() => planBudgetAlertNote(event, "   ")).toThrow(BudgetAlertNoteError);
    expect(() => planBudgetAlertNote(event, "x".repeat(501))).toThrow(BudgetAlertNoteError);
  });
});

describe("postBudgetAlertNoteFollowUp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadOrgSlackTokens.mockResolvedValue(new Map([["inst1", "fake-bot-token"]]));
    postSlackThreadReply.mockResolvedValue(undefined);
    sendMsTeamsToWebhooks.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 });
  });

  it("replies in each Slack thread and follows up on each Teams webhook", async () => {
    const result = await postBudgetAlertNoteFollowUp(
      "org1",
      {
        slackMessages: [
          { installationId: "inst1", channelId: "C1", ts: "1.1" },
          { installationId: "gone", channelId: "C2", ts: "2.2" },
        ],
        msTeamsWebhookIds: ["w1"],
      },
      { title: "Explained", text: "Load test", url: "https://example.test/b" },
    );
    expect(postSlackThreadReply).toHaveBeenCalledWith("fake-bot-token", "C1", "1.1", "Load test");
    // A removed install is skipped, not an error.
    expect(postSlackThreadReply).toHaveBeenCalledTimes(1);
    expect(sendMsTeamsToWebhooks).toHaveBeenCalledWith("org1", ["w1"], {
      title: "Explained",
      body: "Load test",
      url: "https://example.test/b",
    });
    expect(result).toEqual({ slack: 1, msTeams: 1 });
  });

  it("never throws, and does nothing for an alert that reached no chat", async () => {
    loadOrgSlackTokens.mockRejectedValue(new Error("db down"));
    await expect(
      postBudgetAlertNoteFollowUp(
        "org1",
        {
          slackMessages: [{ installationId: "inst1", channelId: "C1", ts: "1.1" }],
          msTeamsWebhookIds: null,
        },
        { title: "t", text: "x" },
      ),
    ).resolves.toEqual({ slack: 0, msTeams: 0 });
    await postBudgetAlertNoteFollowUp(
      "org1",
      { slackMessages: null, msTeamsWebhookIds: null },
      { title: "t", text: "x" },
    );
    expect(sendMsTeamsToWebhooks).not.toHaveBeenCalled();
  });
});
