import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

/** The real error class: the handlers branch on `instanceof` and on `status`. */
class EventSubscriptionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "EventSubscriptionError";
  }
}

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  redeliver: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@infrawrench/server-core/events/store", () => ({
  EventSubscriptionError,
  createEventSubscription: (...a: unknown[]) => mocks.create(...a),
  queueRedelivery: (...a: unknown[]) => mocks.redeliver(...a),
}));
vi.mock("@infrawrench/server-core/events/deliver", () => ({}));
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mocks.audit(...a) }));

const { eventSubscriptionsDomain, parseSubscriptionBody } =
  await import("@/http/domains/event-subscriptions/index");

const app = (permissions: string[]) =>
  buildTestApi(eventSubscriptionsDomain, {
    basePath: "/api/org/org-1/event-subscriptions",
    permissions,
  });

const WEBHOOK_BODY = { name: "Ops", destination: { kind: "webhook", url: "https://x.io" } };

beforeEach(() => vi.clearAllMocks());

describe("routes", () => {
  it("serves the catalog to any member", async () => {
    const res = await app([]).request("/catalog");
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).eventTypes)).toBe(true);
  });

  it("keeps everything else to org:settings:write", async () => {
    const res = await app(["costs:read"]).request("/", {
      method: "POST",
      body: JSON.stringify(WEBHOOK_BODY),
    });
    expect(res.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates with 201, tells the store whether the caller reads costs, and audits", async () => {
    const result = {
      subscription: { id: "sub-1", destinationLabel: "x.io" },
      secret: "iwhsec_one",
    };
    mocks.create.mockResolvedValue(result);
    const res = await app(["org:settings:write"]).request("/", {
      method: "POST",
      body: JSON.stringify(WEBHOOK_BODY),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(result);
    expect(mocks.create).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ name: "Ops", enabled: true }),
      { userId: "user-1", canReadCosts: false },
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "event_subscription.create", entityId: "sub-1" }),
    );
  });

  it("answers a malformed body with the field at fault", async () => {
    const res = await app(["org:settings:write"]).request("/", {
      method: "POST",
      body: JSON.stringify({ destination: { kind: "webhook", url: "https://x" } }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "name is required" });
  });

  it("answers a store refusal with the status it carries", async () => {
    mocks.create.mockRejectedValueOnce(new EventSubscriptionError("Needs costs:read", 403));
    const forbidden = await app(["org:settings:write"]).request("/", {
      method: "POST",
      body: JSON.stringify(WEBHOOK_BODY),
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "Needs costs:read" });

    mocks.redeliver.mockRejectedValueOnce(new EventSubscriptionError("Delivery not found.", 404));
    const missing = await app(["org:settings:write"]).request("/deliveries/d-1/redeliver", {
      method: "POST",
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Delivery not found." });
  });
});

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
