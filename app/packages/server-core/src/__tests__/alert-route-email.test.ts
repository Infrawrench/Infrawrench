import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertRule } from "@infrawrench/client-core";

const { resolveRoutingRules, sendAlertEmail } = vi.hoisted(() => ({
  resolveRoutingRules: vi.fn(),
  sendAlertEmail: vi.fn(),
}));

vi.mock("../db/client", () => ({
  db: { insert: () => ({ values: async () => undefined }) },
}));
vi.mock("../alerts/rules", () => ({ resolveRoutingRules }));
vi.mock("../alerts/email", () => ({ sendAlertEmail }));
vi.mock("../push/dispatch", () => ({
  sendPushToOrg: vi.fn(async () => ({ attempted: 0, succeeded: 0 })),
  sendPushToOrgUser: vi.fn(async () => ({ attempted: 0, succeeded: 0 })),
}));
vi.mock("../slack", () => ({
  sendSlackToChannels: vi.fn(async () => ({ attempted: 0, succeeded: 0, failed: 0 })),
  sendSlackToChannelsTracked: vi.fn(async () => ({
    attempted: 0,
    succeeded: 0,
    failed: 0,
    messages: [],
  })),
}));
vi.mock("../msteams", () => ({
  sendMsTeamsToWebhooks: vi.fn(async () => ({ attempted: 0, succeeded: 0, failed: 0 })),
}));
vi.mock("../on-call/store", () => ({ resolveOnCallNow: vi.fn() }));

import { alertReached, routeAlert } from "../alerts/route";

function rule(partial: Partial<AlertRule>): AlertRule {
  return {
    id: "r1",
    name: "Finance",
    enabled: true,
    position: 0,
    conditions: [],
    destinations: [],
    continueOnMatch: false,
    quietHours: null,
    escalation: null,
    ...partial,
  };
}

const event = {
  organizationId: "o1",
  trigger: "budgetAlerts" as const,
  title: "Budget at 80%",
  body: "spend reached 80%",
};

beforeEach(() => {
  resolveRoutingRules.mockReset();
  sendAlertEmail.mockReset();
  sendAlertEmail.mockImplementation(
    async (_e: unknown, r: { userIds: string[]; addresses: string[] }) => ({
      attempted: r.userIds.length + r.addresses.length,
      succeeded: r.userIds.length + r.addresses.length,
    }),
  );
});

describe("routeAlert email", () => {
  it("sends email destinations named by a rule and counts them", async () => {
    resolveRoutingRules.mockResolvedValue({
      rules: [
        rule({
          destinations: [
            { kind: "email-member", userId: "u1" },
            { kind: "email-address", address: "finance@acme.com" },
          ],
        }),
      ],
      usingDefaults: false,
    });
    const result = await routeAlert(event);
    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
    expect(sendAlertEmail.mock.calls[0]![1]).toEqual({
      userIds: ["u1"],
      addresses: ["finance@acme.com"],
    });
    expect(result.byTransport.email).toBe(2);
    expect(alertReached(result)).toBe(true);
  });

  it("delivers the object's own recipients even when a rule swallows the trigger", async () => {
    resolveRoutingRules.mockResolvedValue({
      rules: [rule({ destinations: [] })],
      usingDefaults: false,
    });
    const result = await routeAlert(event, {
      emailRecipients: { userIds: ["u2"], addresses: [] },
      emailReason: "you are on the budget",
    });
    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
    expect(sendAlertEmail.mock.calls[0]![2]).toBe("you are on the budget");
    expect(result.succeeded).toBe(1);
    expect(alertReached(result)).toBe(true);
  });

  it("shares one sent-address set between the object's list and the rules", async () => {
    resolveRoutingRules.mockResolvedValue({
      rules: [rule({ destinations: [{ kind: "email-member", userId: "u1" }] })],
      usingDefaults: false,
    });
    await routeAlert(event, { emailRecipients: { userIds: ["u1"], addresses: [] } });
    const sets = sendAlertEmail.mock.calls.map((c) => c[3]);
    expect(sets).toHaveLength(2);
    expect(sets[0]).toBe(sets[1]);
  });

  it("does not hold the object's recipients for quiet hours", async () => {
    resolveRoutingRules.mockResolvedValue({
      rules: [
        rule({
          destinations: [{ kind: "email-member", userId: "u1" }],
          quietHours: {
            timezone: "UTC",
            startMinute: 0,
            endMinute: 1439,
            days: [],
            urgentOverride: null,
          },
        }),
      ],
      usingDefaults: false,
    });
    const result = await routeAlert(
      { ...event, severity: "warning" },
      {
        emailRecipients: { userIds: [], addresses: ["finance@acme.com"] },
        now: new Date("2026-10-05T12:00:00Z"),
      },
    );
    // The rule's leg is held; the object's own list went out now.
    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
    expect(sendAlertEmail.mock.calls[0]![1]).toEqual({
      userIds: [],
      addresses: ["finance@acme.com"],
    });
    expect(result.held).toBe(1);
  });
});
