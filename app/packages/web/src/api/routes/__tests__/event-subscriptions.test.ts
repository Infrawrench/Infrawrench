import { describe, expect, it, vi } from "vitest";

vi.mock("@infrawrench/server-core/events/store", () => ({}));
vi.mock("@infrawrench/server-core/events/deliver", () => ({}));
vi.mock("../../../services/audit", () => ({ logAudit: vi.fn() }));

const { parseSubscriptionBody } = await import("../event-subscriptions");

describe("parseSubscriptionBody", () => {
  it("fills defaults for a minimal webhook body", () => {
    expect(
      parseSubscriptionBody({ name: "Ops", destination: { kind: "webhook", url: "https://x.io" } }),
    ).toEqual({
      name: "Ops",
      enabled: true,
      destination: { kind: "webhook", url: "https://x.io" },
      eventTypes: [],
      minSeverity: null,
      accountIds: [],
      environments: [],
    });
  });

  it("accepts a publish destination", () => {
    const parsed = parseSubscriptionBody({
      name: "Bus",
      destination: {
        kind: "publish",
        accountId: "a",
        resourceTypeId: "pubsub-topic",
        resourceId: "r",
      },
      minSeverity: "warning",
    });
    expect(parsed).toMatchObject({
      destination: { kind: "publish", resourceId: "r" },
      minSeverity: "warning",
    });
  });

  it("rejects malformed bodies with a message", () => {
    expect(parseSubscriptionBody({ destination: { kind: "webhook", url: "https://x" } })).toMatch(
      /name/,
    );
    expect(parseSubscriptionBody({ name: "x", destination: { kind: "email" } })).toMatch(/kind/);
    expect(
      parseSubscriptionBody({
        name: "x",
        destination: { kind: "webhook", url: "https://x" },
        eventTypes: "a",
      }),
    ).toMatch(/arrays/);
    expect(
      parseSubscriptionBody({
        name: "x",
        destination: { kind: "webhook", url: "https://x" },
        minSeverity: "loud",
      }),
    ).toMatch(/minSeverity/);
  });
});
