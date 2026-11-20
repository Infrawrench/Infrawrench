import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { LiveWatcher } from "@infrawrench/client-core";
import {
  LiveUpdatesProvider,
  useLiveRefresh,
  useLiveRefreshEach,
  watchLive,
} from "../live/index.js";

function fakeWatcher() {
  const watches: Array<{
    topic: string;
    params: unknown;
    fire: () => void;
    options: unknown;
    stopped: boolean;
  }> = [];
  const watcher: LiveWatcher = {
    watch(topic, params, onChange, options) {
      const entry = { topic, params, fire: onChange, options, stopped: false };
      watches.push(entry);
      return () => {
        entry.stopped = true;
      };
    },
    close() {},
  };
  return { watcher, watches };
}

function Probe(props: { refresh: () => void; accountId?: string; enabled?: boolean }) {
  useLiveRefresh(
    "account-resources",
    props.accountId ? { accountId: props.accountId } : null,
    props.refresh,
    { fallbackMs: 1000, ...(props.enabled !== undefined ? { enabled: props.enabled } : {}) },
  );
  return null;
}

describe("useLiveRefresh", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("polls on the fallback interval without a provider", async () => {
    const refresh = vi.fn();
    const view = render(<Probe refresh={refresh} accountId="a1" />);
    await vi.advanceTimersByTimeAsync(3100);
    expect(refresh).toHaveBeenCalledTimes(3);
    view.unmount();
    await vi.advanceTimersByTimeAsync(3000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("watches through the provider's watcher and stops on unmount", async () => {
    const { watcher, watches } = fakeWatcher();
    const refresh = vi.fn();
    const view = render(
      <LiveUpdatesProvider watcher={watcher}>
        <Probe refresh={refresh} accountId="a1" />
      </LiveUpdatesProvider>,
    );
    expect(watches).toHaveLength(1);
    expect(watches[0]).toMatchObject({
      topic: "account-resources",
      params: { accountId: "a1" },
      options: { fallbackMs: 1000 },
    });
    watches[0]!.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    // No interval of its own while the watcher drives it.
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(watches[0]!.stopped).toBe(true);
  });

  it("keeps one watch across re-renders and restarts when the scope changes", () => {
    const { watcher, watches } = fakeWatcher();
    const view = render(
      <LiveUpdatesProvider watcher={watcher}>
        <Probe refresh={() => {}} accountId="a1" />
      </LiveUpdatesProvider>,
    );
    view.rerender(
      <LiveUpdatesProvider watcher={watcher}>
        <Probe refresh={() => {}} accountId="a1" />
      </LiveUpdatesProvider>,
    );
    expect(watches).toHaveLength(1);
    view.rerender(
      <LiveUpdatesProvider watcher={watcher}>
        <Probe refresh={() => {}} accountId="a2" />
      </LiveUpdatesProvider>,
    );
    expect(watches).toHaveLength(2);
    expect(watches[0]!.stopped).toBe(true);
  });

  it("does nothing while disabled or unscoped", async () => {
    const { watcher, watches } = fakeWatcher();
    const refresh = vi.fn();
    render(
      <LiveUpdatesProvider watcher={watcher}>
        <Probe refresh={refresh} accountId="a1" enabled={false} />
        <Probe refresh={refresh} />
      </LiveUpdatesProvider>,
    );
    expect(watches).toHaveLength(0);
    render(<Probe refresh={refresh} />);
    await vi.advanceTimersByTimeAsync(3000);
    expect(refresh).not.toHaveBeenCalled();
  });
});

function EachProbe({ ids, refresh }: { ids: string[]; refresh: (id?: string) => void }) {
  useLiveRefreshEach(
    "account-resources",
    ids.map((accountId) => ({ accountId })),
    ({ accountId }) => refresh(accountId),
    { fallbackMs: 1000 },
  );
  return null;
}

describe("useLiveRefreshEach", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("watches each scope and tells the refresh which one moved", async () => {
    const { watcher, watches } = fakeWatcher();
    const refresh = vi.fn();
    const view = render(
      <LiveUpdatesProvider watcher={watcher}>
        <EachProbe ids={["a1", "a2"]} refresh={refresh} />
      </LiveUpdatesProvider>,
    );
    expect(watches.map((w) => w.params)).toEqual([{ accountId: "a1" }, { accountId: "a2" }]);
    watches[1]!.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledWith("a2");
    // A new array with the same scopes keeps the watches.
    view.rerender(
      <LiveUpdatesProvider watcher={watcher}>
        <EachProbe ids={["a1", "a2"]} refresh={refresh} />
      </LiveUpdatesProvider>,
    );
    expect(watches).toHaveLength(2);
  });

  it("polls every scope without a provider", async () => {
    const refresh = vi.fn();
    render(<EachProbe ids={["a1", "a2"]} refresh={refresh} />);
    await vi.advanceTimersByTimeAsync(1100);
    expect(refresh.mock.calls).toEqual([["a1"], ["a2"]]);
  });
});

describe("watchLive", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("falls back to an interval without a watcher", async () => {
    const refresh = vi.fn();
    const stop = watchLive(null, "resource", { resourceId: "r" }, refresh, { fallbackMs: 500 });
    await vi.advanceTimersByTimeAsync(1100);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it("delegates to the watcher", () => {
    const { watcher, watches } = fakeWatcher();
    const stop = watchLive(watcher, "resource", { resourceId: "r" }, () => {}, {
      fallbackMs: 500,
      safetyMs: 9000,
    });
    expect(watches[0]).toMatchObject({
      topic: "resource",
      params: { resourceId: "r" },
      options: { fallbackMs: 500, safetyMs: 9000 },
    });
    stop();
    expect(watches[0]!.stopped).toBe(true);
  });
});
