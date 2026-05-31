import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks for all @infrawrench/server-core subpath imports ---

const updateWhere = vi.fn();
const updateSet = vi.fn(() => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

vi.mock("@infrawrench/server-core/db/client", () => ({
  db: { update: (...a: unknown[]) => dbUpdate(...a) },
}));

vi.mock("@infrawrench/server-core/db/schema", () => ({
  accounts: { id: "accounts.id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));

const syncAccountResources = vi.fn();
vi.mock("@infrawrench/server-core/sync-resources", () => ({
  syncAccountResources: (...a: unknown[]) => syncAccountResources(...a),
}));

const getPlugin = vi.fn();
vi.mock("@infrawrench/server-core/plugin-loader", () => ({
  getPlugin: (...a: unknown[]) => getPlugin(...a),
}));

const notePollOutcome = vi.fn();
vi.mock("@infrawrench/server-core/twilio-pager", () => ({
  notePollOutcome: (...a: unknown[]) => notePollOutcome(...a),
}));

import { pollAccount, type PollAccountRow } from "./poll-account";
import { TokenBucketRegistry } from "./token-bucket";

const BASE_INTERVAL_MS = 15_000;

function makeRow(overrides: Partial<PollAccountRow> = {}): PollAccountRow {
  return {
    id: "acc-1",
    organizationId: "org-1",
    pluginId: "aws",
    displayName: "My AWS",
    pollFailureCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  getPlugin.mockResolvedValue(null);
  notePollOutcome.mockResolvedValue(undefined);
  // default: a clean sync with no error
  syncAccountResources.mockResolvedValue({ firstError: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pollAccount", () => {
  it("loads the plugin and uses the manifest rate limit when present", async () => {
    getPlugin.mockResolvedValue({
      plugin: { manifest: { rateLimit: { capacity: 5, refillPerSecond: 2 } } },
    });
    const buckets = new TokenBucketRegistry();
    const takeSpy = vi.spyOn(buckets, "tryTake");

    syncAccountResources.mockImplementation(async (_id, _org, opts) => {
      opts.canListType("ec2");
      return { firstError: null };
    });

    await pollAccount(makeRow(), buckets);

    expect(getPlugin).toHaveBeenCalledWith("aws");
    expect(takeSpy).toHaveBeenCalledWith("aws", "acc-1", {
      capacity: 5,
      refillPerSecond: 2,
    });
  });

  it("falls back to the default bucket config when no manifest limit", async () => {
    getPlugin.mockResolvedValue({ plugin: { manifest: {} } });
    const buckets = new TokenBucketRegistry();
    const takeSpy = vi.spyOn(buckets, "tryTake");
    syncAccountResources.mockImplementation(async (_id, _org, opts) => {
      opts.canListType("ec2");
      return { firstError: null };
    });

    await pollAccount(makeRow(), buckets);

    expect(takeSpy).toHaveBeenCalledWith("aws", "acc-1", {
      capacity: 60,
      refillPerSecond: 1,
    });
  });

  it("on success resets failure count and schedules base interval", async () => {
    const buckets = new TokenBucketRegistry();
    await pollAccount(makeRow({ pollFailureCount: 3 }), buckets);

    expect(updateSet).toHaveBeenCalledTimes(1);
    const setArg = updateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.pollFailureCount).toBe(0);
    expect((setArg.nextPollAt as Date).getTime()).toBe(1_000_000 + BASE_INTERVAL_MS);
    expect((setArg.lastPolledAt as Date).getTime()).toBe(1_000_000);
    expect(updateWhere).toHaveBeenCalled();
  });

  it("forwards each type outcome to the pager", async () => {
    const buckets = new TokenBucketRegistry();
    syncAccountResources.mockImplementation(async (_id, _org, opts) => {
      opts.onTypeDone("ec2", "ok");
      return { firstError: null };
    });

    await pollAccount(makeRow(), buckets);

    expect(notePollOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        accountId: "acc-1",
        accountLabel: "My AWS",
        resourceTypeId: "ec2",
        outcome: "ok",
      }),
    );
  });

  it("includes the error in the pager payload when present", async () => {
    const buckets = new TokenBucketRegistry();
    const err = new Error("boom");
    syncAccountResources.mockImplementation(async (_id, _org, opts) => {
      opts.onTypeDone("ec2", "error", err);
      return { firstError: null };
    });

    await pollAccount(makeRow(), buckets);

    expect(notePollOutcome).toHaveBeenCalledWith(expect.objectContaining({ error: err }));
  });

  it("treats a 429 as a transient rate-limit error: penalizes and backs off", async () => {
    const buckets = new TokenBucketRegistry();
    const penalizeSpy = vi.spyOn(buckets, "penalize");
    const err = new Error("HTTP 429 Too Many Requests");
    syncAccountResources.mockImplementation(async (_id, _org, opts) => {
      opts.onTypeDone("ec2", "error", err);
      return { firstError: err };
    });

    await pollAccount(makeRow({ pollFailureCount: 0 }), buckets);

    expect(penalizeSpy).toHaveBeenCalledWith("aws", "acc-1", 5 * 60 * 1000);
    const setArg = updateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.pollFailureCount).toBe(1);
    // backoff = base * 2^(1-1) = base
    expect((setArg.nextPollAt as Date).getTime()).toBe(1_000_000 + BASE_INTERVAL_MS);
  });

  it("uses exponential backoff capped at the max", async () => {
    const buckets = new TokenBucketRegistry();
    const err = new Error("503 service unavailable");
    syncAccountResources.mockImplementation(async (_id, _org, opts) => {
      opts.onTypeDone("ec2", "error", err);
      return { firstError: err };
    });

    // failureCount 99 -> huge exponent should clamp to MAX_BACKOFF_MS (10 min)
    await pollAccount(makeRow({ pollFailureCount: 99 }), buckets);

    const setArg = updateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.pollFailureCount).toBe(100);
    expect((setArg.nextPollAt as Date).getTime()).toBe(1_000_000 + 10 * 60 * 1000);
  });

  it("treats timeout / econnreset / 5xx as transient without penalizing", async () => {
    const buckets = new TokenBucketRegistry();
    const penalizeSpy = vi.spyOn(buckets, "penalize");
    const err = new Error("connection timeout");
    syncAccountResources.mockImplementation(async (_id, _org, opts) => {
      opts.onTypeDone("ec2", "error", err);
      return { firstError: err };
    });

    await pollAccount(makeRow(), buckets);

    expect(penalizeSpy).not.toHaveBeenCalled();
    const setArg = updateSet.mock.calls[0]![0] as Record<string, unknown>;
    // transient + firstError -> hard failure -> backoff scheduled
    expect(setArg.pollFailureCount).toBe(1);
  });

  it("does NOT back off for a non-transient error (e.g. 403)", async () => {
    const buckets = new TokenBucketRegistry();
    const err = new Error("403 forbidden bad credentials");
    syncAccountResources.mockImplementation(async (_id, _org, opts) => {
      opts.onTypeDone("ec2", "error", err);
      return { firstError: err };
    });

    await pollAccount(makeRow({ pollFailureCount: 2 }), buckets);

    const setArg = updateSet.mock.calls[0]![0] as Record<string, unknown>;
    // hardFailure requires a transient error; 403 is not transient
    expect(setArg.pollFailureCount).toBe(0);
    expect((setArg.nextPollAt as Date).getTime()).toBe(1_000_000 + BASE_INTERVAL_MS);
  });

  it("recognises various rate-limit phrasings", async () => {
    for (const phrase of ["rate limit exceeded", "too many requests", "quota exceeded"]) {
      vi.clearAllMocks();
      getPlugin.mockResolvedValue(null);
      const buckets = new TokenBucketRegistry();
      const penalizeSpy = vi.spyOn(buckets, "penalize");
      const err = new Error(phrase);
      syncAccountResources.mockImplementation(async (_id, _org, opts) => {
        opts.onTypeDone("ec2", "error", err);
        return { firstError: err };
      });
      await pollAccount(makeRow(), buckets);
      expect(penalizeSpy).toHaveBeenCalled();
    }
  });

  it("ignores ok outcomes that carry no error in failure detection", async () => {
    const buckets = new TokenBucketRegistry();
    // firstError set but onTypeDone reported a non-error outcome -> no transientFailure
    syncAccountResources.mockImplementation(async (_id, _org, opts) => {
      opts.onTypeDone("ec2", "ok");
      return { firstError: new Error("429 leftover") };
    });

    await pollAccount(makeRow(), buckets);

    const setArg = updateSet.mock.calls[0]![0] as Record<string, unknown>;
    // no transient failure flagged -> not a hard failure -> reset
    expect(setArg.pollFailureCount).toBe(0);
  });
});
