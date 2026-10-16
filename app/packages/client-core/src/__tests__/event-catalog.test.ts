import { describe, expect, it } from "vitest";
import {
  ACCOUNT_SYNC_FAILING,
  COST_ANOMALY_DETECTED,
  EVENT_MAX_ATTEMPTS,
  defineEventType,
  eventMatchesFilters,
  eventRetryDelayMs,
  eventSchemaName,
  filtersIncludeCostEvents,
  formatEventSignatureHeader,
  getEventType,
  listEventTypes,
  parseEventSignatureHeader,
  shouldAutoDisable,
  validateEventSubscriptionInput,
  type EventSubscriptionFilters,
} from "../event-catalog";

const none: EventSubscriptionFilters = {
  eventTypes: [],
  minSeverity: null,
  accountIds: [],
  environments: [],
};
const fact = {
  type: "cost.anomaly.detected",
  severity: "warning" as const,
  accountId: "acc_1",
  environment: "Prod",
};

describe("event registry", () => {
  it("registers the built-in catalog and hides internal types from the picker", () => {
    const types = listEventTypes().map((d) => d.type);
    expect(types).toContain("cost.anomaly.detected");
    expect(types).toContain("account.sync.failing");
    expect(types).not.toContain("infrawrench.test");
    expect(listEventTypes({ includeInternal: true }).map((d) => d.type)).toContain(
      "infrawrench.test",
    );
    expect(getEventType("budget.threshold.crossed")?.carriesCost).toBe(true);
  });

  it("rejects duplicates and malformed names at definition time", () => {
    expect(() => defineEventType({ ...COST_ANOMALY_DETECTED })).toThrow(/already registered/);
    expect(() =>
      defineEventType({ ...ACCOUNT_SYNC_FAILING, type: "Not Dotted", fields: {} }),
    ).toThrow(/dotted lowercase/);
  });

  it("names OpenAPI components by type and version", () => {
    expect(eventSchemaName(COST_ANOMALY_DETECTED)).toBe("EventData_cost_anomaly_detected_v1");
  });
});

describe("eventMatchesFilters", () => {
  it("matches everything with no filters", () => {
    expect(eventMatchesFilters(none, fact)).toBe(true);
  });
  it("filters by type, severity floor, account and environment (case-insensitive)", () => {
    expect(eventMatchesFilters({ ...none, eventTypes: ["drift.detected"] }, fact)).toBe(false);
    expect(eventMatchesFilters({ ...none, minSeverity: "critical" }, fact)).toBe(false);
    expect(eventMatchesFilters({ ...none, minSeverity: "info" }, fact)).toBe(true);
    expect(eventMatchesFilters({ ...none, accountIds: ["acc_2"] }, fact)).toBe(false);
    expect(eventMatchesFilters({ ...none, environments: ["prod"] }, fact)).toBe(true);
  });
  it("never matches an absent fact against a filter", () => {
    expect(
      eventMatchesFilters({ ...none, accountIds: ["acc_1"] }, { ...fact, accountId: null }),
    ).toBe(false);
    expect(
      eventMatchesFilters({ ...none, environments: ["prod"] }, { ...fact, environment: null }),
    ).toBe(false);
  });
  it("treats an all-events subscription as including cost", () => {
    expect(filtersIncludeCostEvents({ eventTypes: [] })).toBe(true);
    expect(filtersIncludeCostEvents({ eventTypes: ["drift.detected"] })).toBe(false);
    expect(filtersIncludeCostEvents({ eventTypes: ["budget.threshold.crossed"] })).toBe(true);
  });
});

describe("delivery policy", () => {
  it("backs off and stops after the last attempt", () => {
    expect(eventRetryDelayMs(1)).toBe(60_000);
    expect(eventRetryDelayMs(EVENT_MAX_ATTEMPTS - 1)).not.toBeNull();
    expect(eventRetryDelayMs(EVENT_MAX_ATTEMPTS)).toBeNull();
  });
  it("auto-disables only after both enough failures and enough time", () => {
    const now = new Date("2026-10-12T00:00:00Z");
    const fourDaysAgo = new Date(now.getTime() - 4 * 86_400_000);
    expect(shouldAutoDisable({ consecutiveFailures: 50, failingSince: new Date(now) }, now)).toBe(
      false,
    );
    expect(shouldAutoDisable({ consecutiveFailures: 3, failingSince: fourDaysAgo }, now)).toBe(
      false,
    );
    expect(shouldAutoDisable({ consecutiveFailures: 20, failingSince: fourDaysAgo }, now)).toBe(
      true,
    );
    expect(shouldAutoDisable({ consecutiveFailures: 99, failingSince: null }, now)).toBe(false);
  });
});

describe("signature header", () => {
  it("round-trips several v1 signatures", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const header = formatEventSignatureHeader(1700000000, [a, b]);
    expect(header).toBe(`t=1700000000,v1=${a},v1=${b}`);
    expect(parseEventSignatureHeader(header)).toEqual({
      timestamp: 1700000000,
      signatures: [a, b],
    });
    expect(parseEventSignatureHeader("v1=zz")).toBeNull();
  });
});

describe("validateEventSubscriptionInput", () => {
  const base = {
    ...none,
    name: "Ops bus",
    enabled: true,
    destination: { kind: "webhook" as const, url: "https://hooks.example.com/iw" },
  };
  it("accepts a plain https webhook", () => {
    expect(validateEventSubscriptionInput(base)).toBeNull();
  });
  it("refuses http, embedded credentials, unknown and internal types", () => {
    expect(
      validateEventSubscriptionInput({
        ...base,
        destination: { kind: "webhook", url: "http://x.io" },
      }),
    ).toMatch(/https/);
    expect(
      validateEventSubscriptionInput({
        ...base,
        destination: { kind: "webhook", url: "https://u:p@x.io" },
      }),
    ).toMatch(/credentials/);
    expect(validateEventSubscriptionInput({ ...base, eventTypes: ["nope.nope"] })).toMatch(
      /Unknown/,
    );
    expect(validateEventSubscriptionInput({ ...base, eventTypes: ["infrawrench.test"] })).toMatch(
      /Unknown/,
    );
  });
});

describe("EventData typing", () => {
  it("infers literal unions, nullability and arrays from the field spec", () => {
    const data: import("../event-catalog").EventData<typeof COST_ANOMALY_DETECTED> = {
      anomalyId: "a",
      day: "2026-10-01",
      kind: "new_source",
      dimension: "provider",
      dimensionKey: "aws",
      actual: 1,
      baseline: 0,
      currency: "USD",
      hints: [],
      driverResourceId: null,
      driverResourceName: null,
      driverDelta: null,
      driverShare: null,
      contributors: [],
    };
    // @ts-expect-error not one of the enum values
    const bad: typeof data.kind = "other";
    expect(data.kind).toBe("new_source");
    void bad;
  });
});

describe("eventDataJsonSchema", () => {
  it("describes enums, nullables, arrays and datetimes", async () => {
    const { eventDataJsonSchema, BUDGET_THRESHOLD_CROSSED, DRIFT_DETECTED } =
      await import("../event-catalog");
    const budget = eventDataJsonSchema(BUDGET_THRESHOLD_CROSSED) as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    expect(budget.properties["currency"]?.["type"]).toEqual(["string", "null"]);
    expect(budget.properties["measure"]?.["enum"]).toEqual(["spend", "usage"]);
    expect(budget.required).toContain("budgetId");
    const drift = eventDataJsonSchema(DRIFT_DETECTED) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(drift.properties["accountIds"]).toMatchObject({ type: "array" });
    expect(drift.properties["since"]).toMatchObject({ type: "string", format: "date-time" });
  });
});
