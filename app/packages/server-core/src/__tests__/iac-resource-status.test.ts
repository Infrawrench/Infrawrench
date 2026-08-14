import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IacStateSummary } from "@infrawrench/client-core";

/**
 * The scope rule for the resource-detail IaC badge.
 *
 * Two document scopes can legitimately cover a resource: one uploaded for its
 * own account, and an org-wide one. Nothing else does — reconciling against
 * "the newest document in the org" can pick up a *different account's* state
 * and produce a confident, wrong badge. These tests pin which scopes are asked
 * for, because that is the whole of the bug.
 */

import { fakePostgres } from "./helpers/fake-postgres";

// Real Drizzle over a recording driver: the resource lookup renders its actual
// SQL against the real schema (and shadow-validates under test:postgres:shadow).
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

const mockGetLatestIacState = vi.fn();
const mockLoadIacStateResources = vi.fn();
vi.mock("../iac/store", () => ({
  IacInputError: class extends Error {},
  getIacState: vi.fn(),
  getLatestIacState: (...a: unknown[]) => mockGetLatestIacState(...a),
  loadIacStateResources: (...a: unknown[]) => mockLoadIacStateResources(...a),
}));

vi.mock("../plugin-loader", () => ({ loadPlugins: () => Promise.resolve([]) }));
vi.mock("../ownership/store", () => ({ lookupResourceOwners: () => Promise.resolve(new Map()) }));

const { getIacResourceStatus, resetIacTypeMapCache } = await import("../iac/service");

/** The resource-lookup select returns `rows` (keys in projection order). */
function selectReturns(rows: Array<Record<string, unknown>>) {
  pg.queueRows(rows);
}

// Keys in the projection order of getIacResourceStatus's select — see
// helpers/fake-postgres.ts.
const resourceRow = {
  id: "res-1",
  pluginId: "demo",
  resourceTypeId: "server",
  accountId: "acct-A",
  displayName: "web",
  externalId: "srv-1",
  fieldsJson: {},
  outputsJson: {},
  parentResourceId: null,
};

const state = (over: Partial<IacStateSummary>): IacStateSummary =>
  ({
    id: "state-1",
    label: "prod",
    accountId: null,
    accountName: null,
    format: "tfstate",
    formatVersion: "4",
    terraformVersion: null,
    serial: null,
    lineage: null,
    resourceCount: 0,
    dataSourceCount: 0,
    redactedAttributeCount: 0,
    uploadedByUserId: null,
    uploadedByName: null,
    parseWarnings: [],
    createdAt: new Date().toISOString(),
    ...over,
  }) as IacStateSummary;

describe("getIacResourceStatus scope selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pg.reset();
    resetIacTypeMapCache();
    mockLoadIacStateResources.mockResolvedValue([]);
  });

  it("asks for the resource's own account first", async () => {
    selectReturns([resourceRow]);
    mockGetLatestIacState.mockResolvedValueOnce(state({ id: "s-A", accountId: "acct-A" }));

    const out = await getIacResourceStatus("org-1", "res-1");

    expect(mockGetLatestIacState).toHaveBeenNthCalledWith(1, "org-1", "acct-A");
    expect(mockGetLatestIacState).toHaveBeenCalledTimes(1);
    expect(out.stateId).toBe("s-A");
  });

  // The regression: the fallback must name the org-wide scope explicitly.
  // Calling with no scope returns the newest document in the org, which may
  // belong to another account entirely.
  it("falls back only to the org-wide scope, never to 'any state in the org'", async () => {
    selectReturns([resourceRow]);
    mockGetLatestIacState.mockResolvedValueOnce(null); // nothing for acct-A
    mockGetLatestIacState.mockResolvedValueOnce(state({ id: "s-org", accountId: null }));

    const out = await getIacResourceStatus("org-1", "res-1");

    expect(mockGetLatestIacState).toHaveBeenCalledTimes(2);
    expect(mockGetLatestIacState).toHaveBeenNthCalledWith(2, "org-1", null);
    // Every call names a scope; none asks for "whatever is newest".
    for (const call of mockGetLatestIacState.mock.calls) {
      expect(call).toHaveLength(2);
    }
    expect(out.stateId).toBe("s-org");
  });

  it("reports no status when neither scope has a document", async () => {
    selectReturns([resourceRow]);
    mockGetLatestIacState.mockResolvedValue(null);

    const out = await getIacResourceStatus("org-1", "res-1");

    // "No state covers this account" is a true answer; a badge computed from
    // another account's state is not.
    expect(out).toEqual({
      status: null,
      stateId: null,
      stateLabel: null,
      terraformAddress: null,
      driftFieldCount: 0,
    });
    expect(mockLoadIacStateResources).not.toHaveBeenCalled();
  });

  it("reports no status for an unknown resource without touching state at all", async () => {
    selectReturns([]);
    const out = await getIacResourceStatus("org-1", "nope");
    expect(out.status).toBeNull();
    expect(mockGetLatestIacState).not.toHaveBeenCalled();
  });
});
