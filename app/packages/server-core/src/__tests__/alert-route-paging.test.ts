import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertRule } from "@infrawrench/client-core";

const {
  resolveRoutingRules,
  sendPagingDestinations,
  applyPagingLifecycle,
  resolveProviderOnCallMembers,
  sendPushToOrgUser,
  pluginCodeAvailable,
  inserted,
} = vi.hoisted(() => ({
  resolveRoutingRules: vi.fn(),
  sendPagingDestinations: vi.fn(),
  applyPagingLifecycle: vi.fn(),
  resolveProviderOnCallMembers: vi.fn(),
  sendPushToOrgUser: vi.fn(),
  pluginCodeAvailable: vi.fn(() => true),
  inserted: [] as unknown[],
}));

vi.mock("../db/client", () => ({
  db: {
    insert: () => ({
      values: async (v: unknown) => {
        inserted.push(v);
      },
    }),
  },
}));
vi.mock("../alerts/rules", () => ({ resolveRoutingRules }));
vi.mock("../alerts/email", () => ({ sendAlertEmail: vi.fn() }));
vi.mock("../push/dispatch", () => ({
  sendPushToOrg: vi.fn(async () => ({ attempted: 0, succeeded: 0 })),
  sendPushToOrgUser,
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
vi.mock("../on-call/store", () => ({
  resolveOnCallNow: vi.fn(async () => ({ shift: { userId: "u1" }, next: null })),
}));
vi.mock("../paging/providers", () => ({
  sendPagingDestinations,
  applyPagingLifecycle,
  resolveProviderOnCallMembers,
}));
vi.mock("../plugin-loader", () => ({ pluginCodeAvailable }));

import { alertReached, routeAlert } from "../alerts/route";

function rule(partial: Partial<AlertRule>): AlertRule {
  return {
    id: "r1",
    name: "Pager",
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

const probeDown = {
  organizationId: "o1",
  trigger: "probeAlerts" as const,
  title: "Probe down: api",
  body: "api failed 3 checks",
  pushData: { type: "probe_alert" as const, orgId: "o1", probeId: "p1", status: "down" as const },
  facts: { key: "api" },
  lifecycle: { key: "probe:p1", phase: "open" as const },
};

beforeEach(() => {
  resolveRoutingRules.mockReset();
  sendPagingDestinations.mockReset();
  sendPagingDestinations.mockImplementation(async (_a: unknown, d: unknown[]) => ({
    attempted: d.length,
    succeeded: d.length,
  }));
  applyPagingLifecycle.mockReset();
  resolveProviderOnCallMembers.mockReset();
  sendPushToOrgUser.mockReset();
  sendPushToOrgUser.mockResolvedValue({ attempted: 1, succeeded: 1 });
  pluginCodeAvailable.mockReturnValue(true);
  inserted.length = 0;
});

describe("routeAlert paging providers", () => {
  it("opens an upstream alert for a paging-provider destination, with the lifecycle", async () => {
    resolveRoutingRules.mockResolvedValue({
      rules: [
        rule({ destinations: [{ kind: "paging-provider", accountId: "a1", targetId: "SVC1" }] }),
      ],
      usingDefaults: false,
    });
    const result = await routeAlert(probeDown);
    expect(sendPagingDestinations).toHaveBeenCalledTimes(1);
    const [alert, targets] = sendPagingDestinations.mock.calls[0]!;
    expect(targets).toEqual([{ accountId: "a1", targetId: "SVC1" }]);
    expect(alert).toMatchObject({
      organizationId: "o1",
      severity: "critical",
      lifecycle: { key: "probe:p1", phase: "open" },
    });
    expect(result.succeeded).toBe(1);
    expect(alertReached(result)).toBe(true);
    expect(applyPagingLifecycle).not.toHaveBeenCalled();
  });

  it("resolves every upstream alert on recovery and never opens a new one", async () => {
    resolveRoutingRules.mockResolvedValue({
      rules: [
        rule({ destinations: [{ kind: "paging-provider", accountId: "a1", targetId: "SVC1" }] }),
      ],
      usingDefaults: false,
    });
    await routeAlert({
      ...probeDown,
      title: "Probe recovered: api",
      severity: "info",
      lifecycle: { key: "probe:p1", phase: "resolved" },
    });
    expect(applyPagingLifecycle).toHaveBeenCalledWith("o1", "probe:p1", "resolved");
    expect(sendPagingDestinations).not.toHaveBeenCalled();
  });

  it("resolves upstream even when no rule routes the recovery anywhere", async () => {
    resolveRoutingRules.mockResolvedValue({ rules: [], usingDefaults: false });
    await routeAlert({ ...probeDown, lifecycle: { key: "probe:p1", phase: "resolved" } });
    expect(applyPagingLifecycle).toHaveBeenCalledWith("o1", "probe:p1", "resolved");
  });

  it("does not re-apply the lifecycle when replaying a held copy", async () => {
    await routeAlert(
      { ...probeDown, lifecycle: { key: "probe:p1", phase: "resolved" } },
      {
        pinnedLegs: [
          {
            ruleId: "r1",
            ruleName: "Pager",
            destinations: [{ kind: "push" }],
            escalation: null,
            holdUntil: null,
          },
        ],
      },
    );
    expect(applyPagingLifecycle).not.toHaveBeenCalled();
  });

  it("dedupes provider on-call people with rotation people by user", async () => {
    resolveProviderOnCallMembers.mockResolvedValue(["u1", "u2"]);
    resolveRoutingRules.mockResolvedValue({
      rules: [
        rule({
          destinations: [
            { kind: "on-call", scheduleId: "s1" },
            { kind: "provider-on-call", accountId: "a1", sourceId: "PSCHED" },
          ],
        }),
      ],
      usingDefaults: false,
    });
    const result = await routeAlert(probeDown);
    expect(resolveProviderOnCallMembers).toHaveBeenCalledWith("o1", "a1", "PSCHED");
    const users = sendPushToOrgUser.mock.calls.map((c) => c[1]).sort();
    expect(users).toEqual(["u1", "u2"]);
    expect(result.succeeded).toBe(2);
  });

  it("defers provider on-call to the follow-up pass where plugin code cannot run", async () => {
    pluginCodeAvailable.mockReturnValue(false);
    resolveProviderOnCallMembers.mockResolvedValue(["u9"]);
    resolveRoutingRules.mockResolvedValue({
      rules: [
        rule({
          destinations: [
            { kind: "push" },
            { kind: "provider-on-call", accountId: "a1", sourceId: "PSCHED" },
          ],
        }),
      ],
      usingDefaults: false,
    });
    const result = await routeAlert(probeDown, { bypassQuietHours: true });
    expect(resolveProviderOnCallMembers).not.toHaveBeenCalled();
    expect(result.held).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      state: "held",
      destinations: [{ kind: "provider-on-call", accountId: "a1", sourceId: "PSCHED" }],
    });
  });
});
