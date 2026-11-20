import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_DEBOUNCE_MS,
  LIVE_RENEW_EARLY_MS,
  LIVE_SAFETY_MS,
  createLiveWatcher,
  readLiveTicket,
  type LiveNeonClient,
  type LiveNeonSubscription,
  type LiveSealedQuery,
} from "../live";

const sealed = (expiresAt: number, queryFingerprint = "fp-1"): LiveSealedQuery => ({
  capability: "cap",
  queryFingerprint,
  expiresAt,
});

const neonTicket = (expiresAt: number, fingerprint = "fp-1") => ({
  driver: "neon",
  url: "wss://realtime.example.test",
  query: sealed(expiresAt, fingerprint),
});

/** A fake Neon client whose subscriptions the test drives by hand. */
function fakeNeon() {
  const subs: Array<{
    update: (u: unknown) => void;
    state: (s: { status: string }) => void;
    renewals: LiveSealedQuery[];
    unsubscribed: boolean;
  }> = [];
  let closed = 0;
  const client: LiveNeonClient = {
    subscribe() {
      const entry = {
        update: (_u: unknown) => {},
        state: (_s: { status: string }) => {},
        renewals: [] as LiveSealedQuery[],
        unsubscribed: false,
      };
      subs.push(entry);
      const sub: LiveNeonSubscription = {
        onUpdate(listener) {
          entry.update = listener;
          return () => {};
        },
        onStateChange(listener) {
          entry.state = listener;
          return () => {};
        },
        async renew(query) {
          entry.renewals.push(query);
        },
        unsubscribe() {
          entry.unsubscribed = true;
        },
      };
      return sub;
    },
    close() {
      closed += 1;
    },
  };
  const connect = vi.fn(async () => client);
  return { subs, connect, closed: () => closed };
}

describe("readLiveTicket", () => {
  it("reads a well-formed neon ticket", () => {
    expect(readLiveTicket(neonTicket(5))).toEqual(neonTicket(5));
  });

  it.each([
    [null],
    [{ driver: "poll" }],
    [{ driver: "a-future-driver", url: "x" }],
    [{ driver: "neon", url: "wss://x" }],
    [{ driver: "neon", url: "wss://x", query: { capability: "c", queryFingerprint: "f" } }],
  ])("reads %j as poll", (value) => {
    expect(readLiveTicket(value)).toEqual({ driver: "poll" });
  });
});

describe("createLiveWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls on the panel's interval when the server answers poll", async () => {
    const neon = fakeNeon();
    const watcher = createLiveWatcher(async () => ({ driver: "poll" }), { connect: neon.connect });
    const onChange = vi.fn();
    const stop = watcher.watch("change-freezes", {}, onChange, { fallbackMs: 1000 });
    await vi.advanceTimersByTimeAsync(3500);
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(neon.connect).not.toHaveBeenCalled();
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("polls when the ticket route fails (an older server)", async () => {
    const watcher = createLiveWatcher(async () => {
      throw new Error("404");
    });
    const onChange = vi.fn();
    watcher.watch("jit-requests", {}, onChange, { fallbackMs: 1000 });
    await vi.advanceTimersByTimeAsync(2100);
    expect(onChange).toHaveBeenCalledTimes(2);
    watcher.close();
  });

  it("refetches on a change after the initial result, debounced", async () => {
    const neon = fakeNeon();
    const source = vi.fn(async () => neonTicket(60_000));
    const watcher = createLiveWatcher(source, { connect: neon.connect });
    const onChange = vi.fn();
    watcher.watch("account-resources", { accountId: "a1" }, onChange, { fallbackMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(source).toHaveBeenCalledWith("account-resources", { accountId: "a1" });
    const [sub] = neon.subs;
    sub!.update({ type: "rows" });
    await vi.advanceTimersByTimeAsync(LIVE_DEBOUNCE_MS * 2);
    expect(onChange).not.toHaveBeenCalled();
    sub!.update({ type: "changes" });
    sub!.update({ type: "changes" });
    await vi.advanceTimersByTimeAsync(LIVE_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    // No interval poll while the push channel is live.
    await vi.advanceTimersByTimeAsync(5000);
    expect(onChange).toHaveBeenCalledTimes(1);
    watcher.close();
  });

  it("renews the sealed query before it expires", async () => {
    const neon = fakeNeon();
    let expiresAt = 60_000;
    const source = vi.fn(async () => neonTicket(expiresAt));
    const watcher = createLiveWatcher(source, { connect: neon.connect });
    watcher.watch("ci-runs", {}, () => {}, { fallbackMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expiresAt = 120_000;
    await vi.advanceTimersByTimeAsync(60_000 - LIVE_RENEW_EARLY_MS);
    expect(source).toHaveBeenCalledTimes(2);
    expect(neon.subs[0]!.renewals).toEqual([sealed(120_000)]);
    watcher.close();
    expect(neon.subs[0]!.unsubscribed).toBe(true);
  });

  it("resubscribes when the renewed query is a different one", async () => {
    const neon = fakeNeon();
    let fingerprint = "fp-1";
    const watcher = createLiveWatcher(async () => neonTicket(60_000, fingerprint), {
      connect: neon.connect,
    });
    watcher.watch("workflow-approvals", {}, () => {}, { fallbackMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    fingerprint = "fp-2";
    await vi.advanceTimersByTimeAsync(60_000 - LIVE_RENEW_EARLY_MS);
    expect(neon.subs).toHaveLength(2);
    expect(neon.subs[0]!.unsubscribed).toBe(true);
    expect(neon.subs[0]!.renewals).toEqual([]);
    watcher.close();
  });

  it("falls back to polling when the subscription errors", async () => {
    const neon = fakeNeon();
    const watcher = createLiveWatcher(async () => neonTicket(600_000), { connect: neon.connect });
    const onChange = vi.fn();
    watcher.watch("resource", { resourceId: "r1" }, onChange, { fallbackMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    neon.subs[0]!.state({ status: "error" });
    await vi.advanceTimersByTimeAsync(2100);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(neon.subs[0]!.unsubscribed).toBe(true);
    watcher.close();
  });

  it("falls back to polling when the SDK fails to load", async () => {
    const watcher = createLiveWatcher(async () => neonTicket(600_000), {
      connect: async () => {
        throw new Error("chunk failed");
      },
    });
    const onChange = vi.fn();
    watcher.watch("access-requests", {}, onChange, { fallbackMs: 1000 });
    await vi.advanceTimersByTimeAsync(1100);
    expect(onChange).toHaveBeenCalledTimes(1);
    watcher.close();
  });

  it("keeps a slow safety refetch while live, and a far expiry does not spin", async () => {
    const neon = fakeNeon();
    const source = vi.fn(async () => neonTicket(Number.MAX_SAFE_INTEGER));
    const watcher = createLiveWatcher(source, {
      connect: neon.connect,
    });
    const onChange = vi.fn();
    watcher.watch("jit-requests", {}, onChange, { fallbackMs: 1000 });
    await vi.advanceTimersByTimeAsync(LIVE_SAFETY_MS + 10);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(source).toHaveBeenCalledTimes(1);
    watcher.close();
  });

  it("shares one client per URL and closes it once", async () => {
    const neon = fakeNeon();
    const watcher = createLiveWatcher(async () => neonTicket(600_000), { connect: neon.connect });
    watcher.watch("ci-runs", {}, () => {}, { fallbackMs: 1000 });
    watcher.watch("change-freezes", {}, () => {}, { fallbackMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(neon.connect).toHaveBeenCalledTimes(1);
    expect(neon.subs).toHaveLength(2);
    watcher.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(neon.closed()).toBe(1);
  });
});
