import { beforeEach, describe, expect, it, vi } from "vitest";
import { alertReachedImpl, routed } from "./helpers/route-alert";

/**
 * Commitment alert evaluation tests that exercise the *pipeline*, not the
 * maths — the pure detectors have their own suites.
 *
 * What this file is for:
 *
 * 1. **Both triggers go through the alert routing layer.** Not
 *    `sendSlackToChannels`, not `sendPushToOrg`, not `sendMsTeamsToWebhooks`.
 *    Routing rules, quiet hours and escalation only apply to alerts that go
 *    through `routeAlert`, and a detector that reached for a transport
 *    directly would work perfectly in a demo and ignore every rule an org
 *    ever wrote. The three transport modules are mocked and asserted
 *    untouched.
 * 2. **Fire-once survives the round trip.** A second pass over the same
 *    inventory notifies nobody, because the unique index refuses the insert
 *    and an insert that returns nothing never routes.
 * 3. **A null utilization stays silent end to end.** The pure test proves the
 *    judgement; this proves nothing downstream re-introduces it.
 */

const getAccountDataDays = vi.fn();
const getCommitmentDeliveredTotals = vi.fn();
vi.mock("../clickhouse/commitment-readers", () => ({
  getAccountDataDays,
  getCommitmentDeliveredTotals,
}));

const loadPlugins = vi.fn();
vi.mock("../plugin-loader", () => ({ loadPlugins }));

const getOrgEfficiencySettings = vi.fn();
vi.mock("../cost/efficiency-settings", () => ({ getOrgEfficiencySettings }));

/**
 * The transports. Mocked purely so the assertions below can prove nothing
 * called them — see point 1.
 */
const sendPushToOrg = vi.fn();
const sendSlackToChannels = vi.fn();
const sendMsTeamsToWebhooks = vi.fn();
vi.mock("../push/dispatch", () => ({ sendPushToOrg }));
vi.mock("../slack", () => ({
  sendSlackToChannels,
  sendSlackToChannelsTracked: sendSlackToChannels,
}));
vi.mock("../msteams", () => ({ sendMsTeamsToWebhooks }));

const ACCOUNTS = { id: "id", displayName: "display_name", pluginId: "plugin_id" };
const ACCOUNT_COMMITMENTS = { organizationId: "organization_id", accountId: "account_id" };
const EXPIRY_EVENTS = { id: "expiry_id" };
const IDLE_EVENTS = { id: "idle_id" };

vi.mock("../db/schema", () => ({
  accounts: ACCOUNTS,
  accountCommitments: ACCOUNT_COMMITMENTS,
  commitmentExpiryEvents: EXPIRY_EVENTS,
  commitmentIdleEvents: IDLE_EVENTS,
}));

/** Rows the fake db hands back for each table. */
let accountRows: Array<Record<string, unknown>> = [];
let holdingRows: Array<Record<string, unknown>> = [];
/** Whether the once-per-period insert finds a free slot. */
let insertWins = true;
/** Every row inserted this pass, tagged with which table took it. */
let inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];

const db = {
  select: (_cols?: unknown) => ({
    from: (table: unknown) => ({
      where: () => Promise.resolve(table === ACCOUNTS ? accountRows : holdingRows),
    }),
  }),
  insert: (table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      inserts.push({ table, values });
      return {
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve(insertWins ? [{ id: `ev${inserts.length}` }] : []),
        }),
      };
    },
  }),
  update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
};
vi.mock("../db/client", () => ({ db }));

const routeAlert = vi.fn(async (..._args: unknown[]) => routed());
vi.mock("../alerts/route", () => ({
  routeAlert: (...a: unknown[]) => routeAlert(...a),
  alertReached: alertReachedImpl,
}));

let evaluate: typeof import("../commitments/alert-eval").evaluateCommitmentAlertsForOrg;

const NOW = new Date("2026-08-10T12:00:00Z");
const DAY_MS = 86_400_000;

const SETTINGS = {
  commitmentExpiryEnabled: true,
  commitmentExpiryHorizonDays: [60, 30, 7],
  commitmentExpiryAlertOnExpired: true,
  commitmentIdleEnabled: true,
  commitmentIdleThresholdPercent: 70,
  commitmentIdleWindowDays: 30,
  commitmentIdleMinMeasuredDays: 14,
  commitmentIdleMinWasteCents: 5000,
  unitCostRegressionEnabled: true,
  unitCostThresholdPercent: 20,
  unitCostWindowDays: 14,
  unitCostMinReportedDays: 10,
  unitCostMinSpendCents: 10_000,
};

/** The 30 days ending today — the window the driver builds. */
function windowDays(): Set<string> {
  const days = new Set<string>();
  const end = new Date("2026-08-10T00:00:00Z").valueOf();
  for (let i = 0; i < 30; i++) days.add(new Date(end - i * DAY_MS).toISOString().slice(0, 10));
  return days;
}

function holding(over: Record<string, unknown> = {}) {
  return {
    accountId: "acct1",
    pluginId: "aws",
    commitmentId: "sp-1",
    kind: "savings_plan",
    description: "1-yr Compute Savings Plan",
    scope: null,
    region: "eu-west-1",
    state: "active",
    startDate: new Date("2026-01-01T00:00:00Z"),
    endDate: new Date("2026-09-09T00:00:00Z"), // 30 days out
    currency: "USD",
    hourlyCommitmentAmount: 1,
    unitCommitments: null,
    ...over,
  };
}

function triggersRouted(): string[] {
  return routeAlert.mock.calls.map((call) => (call[0] as { trigger: string }).trigger);
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  accountRows = [{ id: "acct1", displayName: "prod", pluginId: "aws" }];
  holdingRows = [holding()];
  insertWins = true;
  inserts = [];
  // Both capabilities declared: the plugin lists commitments *and* stamps
  // charge types, which is what makes derived utilization legal.
  loadPlugins.mockResolvedValue([
    {
      plugin: {
        manifest: {
          id: "aws",
          commitments: { kinds: ["savings_plan"] },
          costs: { chargeTypes: true },
        },
      },
    },
  ]);
  getOrgEfficiencySettings.mockResolvedValue({ ...SETTINGS });
  getAccountDataDays.mockResolvedValue(new Map([["acct1", windowDays()]]));
  // $1/hr × 24 × 30 = $720 obligation; $250 delivered is ~35%.
  getCommitmentDeliveredTotals.mockResolvedValue([
    { account_id: "acct1", commitment_id: "sp-1", currency: "USD", amount: 250 },
  ]);
  ({ evaluateCommitmentAlertsForOrg: evaluate } = await import("../commitments/alert-eval"));
});

describe("evaluateCommitmentAlertsForOrg — routing", () => {
  it("raises both kinds through the alert routing layer, never a transport", async () => {
    await evaluate("org1", NOW, true);

    expect(triggersRouted().sort()).toEqual(["commitmentExpiryAlerts", "commitmentIdleAlerts"]);
    // The whole point: quiet hours and escalation only exist above
    // `routeAlert`, so a detector that called a transport directly would
    // bypass every rule the org wrote.
    expect(sendPushToOrg).not.toHaveBeenCalled();
    expect(sendSlackToChannels).not.toHaveBeenCalled();
    expect(sendMsTeamsToWebhooks).not.toHaveBeenCalled();
  });

  it("carries the deep-link payload and the routable facts", async () => {
    await evaluate("org1", NOW, true);
    const expiry = routeAlert.mock.calls
      .map((c) => c[0] as Record<string, any>)
      .find((e) => e["trigger"] === "commitmentExpiryAlerts")!;

    expect(expiry["pushData"]).toMatchObject({
      type: "commitment_expiry",
      orgId: "org1",
      accountId: "acct1",
      commitmentId: "sp-1",
      horizonDays: 30,
    });
    // Rules match on facts, not on the sentence.
    expect(expiry["facts"]).toMatchObject({ accountId: "acct1", pluginId: "aws", currency: "USD" });
    expect(expiry["facts"]["amountCents"]).toBeGreaterThan(0);
  });

  it("names the thing, the number, and what to do", async () => {
    await evaluate("org1", NOW, true);
    const idle = routeAlert.mock.calls
      .map((c) => c[0] as Record<string, any>)
      .find((e) => e["trigger"] === "commitmentIdleAlerts")!;

    expect(idle["body"]).toContain("1-yr Compute Savings Plan");
    expect(idle["body"]).toContain("prod");
    expect(idle["body"]).toMatch(/\$\d/); // the money, not just a percentage
    expect(idle["body"]).toContain("Move matching workloads");
  });

  it("marks an idle commitment info rather than warning", async () => {
    // Nothing is breaking; it is money already spent, restated monthly. An
    // org that sleeps through `info` should keep sleeping through it.
    await evaluate("org1", NOW, true);
    const idle = routeAlert.mock.calls
      .map((c) => c[0] as Record<string, any>)
      .find((e) => e["trigger"] === "commitmentIdleAlerts")!;
    // The trigger's own default severity is `info`; the driver passes none.
    expect(idle["severity"]).toBeUndefined();
  });
});

describe("evaluateCommitmentAlertsForOrg — fire once", () => {
  it("notifies nobody when the events row already exists", async () => {
    insertWins = false;
    await evaluate("org1", NOW, true);
    // Both detectors still ran and both still tried to record — they just
    // lost the race with their own earlier pass.
    expect(inserts.length).toBe(2);
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("keys the expiry row on the term end, so an extension re-warns", async () => {
    await evaluate("org1", NOW, true);
    const expiryRow = inserts.find((i) => i.table === EXPIRY_EVENTS)!.values;
    expect(expiryRow["termEndDay"]).toBe("2026-09-09");
    expect(expiryRow["horizonDays"]).toBe(30);
  });

  it("keys the idle row on the calendar month, not the sliding window", async () => {
    await evaluate("org1", NOW, true);
    const idleRow = inserts.find((i) => i.table === IDLE_EVENTS)!.values;
    expect(idleRow["periodKey"]).toBe("2026-08");
  });
});

describe("evaluateCommitmentAlertsForOrg — unmeasurable utilization", () => {
  it("still warns about expiry but never about idleness when nothing was collected", async () => {
    getAccountDataDays.mockResolvedValue(new Map());
    getCommitmentDeliveredTotals.mockResolvedValue([]);

    await evaluate("org1", NOW, true);

    // A term end is a term end whether or not any cost row landed.
    expect(triggersRouted()).toEqual(["commitmentExpiryAlerts"]);
  });

  it("never calls a commitment idle when the account carries no attribution", async () => {
    loadPlugins.mockResolvedValue([
      // Lists commitments, but stamps no charge types — every row reads as
      // plain uncovered usage, so delivered would be 0 for a healthy plan.
      { plugin: { manifest: { id: "aws", commitments: { kinds: ["savings_plan"] } } } },
    ]);
    getCommitmentDeliveredTotals.mockResolvedValue([]);

    await evaluate("org1", NOW, true);

    expect(triggersRouted()).toEqual(["commitmentExpiryAlerts"]);
  });

  it("never calls a unit-denominated commitment idle", async () => {
    holdingRows = [
      holding({
        hourlyCommitmentAmount: null,
        currency: null,
        unitCommitments: [{ unit: "vCPU", amount: 2000 }],
      }),
    ];
    getCommitmentDeliveredTotals.mockResolvedValue([]);

    await evaluate("org1", NOW, true);

    expect(triggersRouted()).toEqual(["commitmentExpiryAlerts"]);
  });
});

describe("evaluateCommitmentAlertsForOrg — the org's settings", () => {
  it("does nothing at all when both detectors are off", async () => {
    getOrgEfficiencySettings.mockResolvedValue({
      ...SETTINGS,
      commitmentExpiryEnabled: false,
      commitmentIdleEnabled: false,
    });
    await evaluate("org1", NOW, true);
    expect(routeAlert).not.toHaveBeenCalled();
    expect(getAccountDataDays).not.toHaveBeenCalled();
  });

  it("runs only the enabled half", async () => {
    getOrgEfficiencySettings.mockResolvedValue({ ...SETTINGS, commitmentIdleEnabled: false });
    await evaluate("org1", NOW, true);
    expect(triggersRouted()).toEqual(["commitmentExpiryAlerts"]);
  });

  it("swallows a failed pass rather than breaking the poller", async () => {
    getCommitmentDeliveredTotals.mockRejectedValue(new Error("clickhouse down"));
    await expect(evaluate("org1", NOW, true)).resolves.toBeUndefined();
    expect(routeAlert).not.toHaveBeenCalled();
  });
});
