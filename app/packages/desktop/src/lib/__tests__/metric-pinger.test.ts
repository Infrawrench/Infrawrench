import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const select = vi.fn();
const execute = vi.fn();
const getPlugin = vi.fn();
const buildPluginHostServices = vi.fn();

vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../../db/client", () => ({ getDb: () => Promise.resolve({ select, execute }) }));
vi.mock("../../plugins/loader", () => ({ getPlugin: (...args: unknown[]) => getPlugin(...args) }));
vi.mock("../sql-drivers", () => ({
  buildPluginHostServices: (...args: unknown[]) => buildPluginHostServices(...args),
}));

import { METRIC_PINGS_CHANGED_EVENT } from "../metric-pings";

type WindowListener = (...args: unknown[]) => void;

function makeWindow() {
  const listeners = new Map<string, WindowListener[]>();
  return {
    listeners,
    addEventListener(type: string, cb: WindowListener) {
      const list = listeners.get(type) ?? [];
      list.push(cb);
      listeners.set(type, list);
    },
    emit(type: string) {
      for (const cb of listeners.get(type) ?? []) cb();
    },
  };
}

const basePing = {
  id: "ping-1",
  resource_id: "r1",
  account_id: "acc-1",
  plugin_id: "pl",
  resource_type_id: "rt",
  resource_display_name: "DB",
  metric_label: "CPU",
  min_value: null as number | null,
  max_value: 80 as number | null,
  last_alert_state: null as string | null,
};

function loadPinger() {
  return import("../metric-pinger");
}

beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
  select.mockReset();
  execute.mockReset();
  getPlugin.mockReset();
  buildPluginHostServices.mockReset();
  invoke.mockResolvedValue(undefined);
  execute.mockResolvedValue({ rowsAffected: 1, lastInsertId: 0 });
  buildPluginHostServices.mockReturnValue({ http: {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function flush() {
  // Allow queued microtasks (the async tick/syncActiveCount) to settle.
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("startMetricPinger", () => {
  it("syncs active count, registers an interval + change listener, and is idempotent", async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const win = makeWindow();
    vi.stubGlobal("window", win);
    select.mockResolvedValue([]); // count rows + tick pings

    const { startMetricPinger } = await loadPinger();
    startMetricPinger();
    startMetricPinger(); // second call is a no-op

    await flush();

    // syncActiveCount queried metric_pings count
    expect(select).toHaveBeenCalledWith("SELECT COUNT(*) AS c FROM metric_pings");
    expect(invoke).toHaveBeenCalledWith("set_pings_active", { count: 0 });
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(win.listeners.get(METRIC_PINGS_CHANGED_EVENT)).toHaveLength(1);
  });

  it("re-syncs and ticks when the change event fires", async () => {
    vi.useFakeTimers();
    const win = makeWindow();
    vi.stubGlobal("window", win);
    select.mockResolvedValue([{ c: 0 }]);

    const { startMetricPinger } = await loadPinger();
    startMetricPinger();
    await flush();

    const before = invoke.mock.calls.filter((c) => c[0] === "set_pings_active").length;
    win.emit(METRIC_PINGS_CHANGED_EVENT);
    await flush();
    const after = invoke.mock.calls.filter((c) => c[0] === "set_pings_active").length;
    expect(after).toBeGreaterThan(before);
  });

  it("logs and continues when syncActiveCount fails", async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("window", makeWindow());
    select.mockRejectedValue(new Error("db down"));

    const { startMetricPinger } = await loadPinger();
    startMetricPinger();
    await flush();
    expect(errSpy).toHaveBeenCalledWith("metric-pinger: syncActiveCount failed", expect.any(Error));
    errSpy.mockRestore();
  });
});

describe("metric-pinger tick (via interval)", () => {
  async function runOneTick(opts: {
    pings: (typeof basePing)[];
    series?: { label: string; unit?: string; points: { value: number }[] }[];
    credentialsThrows?: boolean;
    noClient?: boolean;
    noFetch?: boolean;
  }) {
    vi.useFakeTimers();
    vi.stubGlobal("window", makeWindow());
    // First select = COUNT for syncActiveCount; subsequent = SELECT * for tick.
    select.mockImplementation((sql: string) => {
      if (String(sql).includes("COUNT")) return Promise.resolve([{ c: opts.pings.length }]);
      return Promise.resolve(opts.pings);
    });
    if (opts.credentialsThrows) {
      invoke.mockImplementation((channel: string) => {
        if (channel === "account_get_credentials") return Promise.reject(new Error("no creds"));
        return Promise.resolve(undefined);
      });
    } else {
      invoke.mockImplementation((channel: string) => {
        if (channel === "account_get_credentials") return Promise.resolve({ token: "t" });
        return Promise.resolve(undefined);
      });
    }
    const fetchMetricSeries = vi.fn().mockResolvedValue(opts.series ?? []);
    const createClient = vi
      .fn()
      .mockReturnValue(opts.noClient ? {} : opts.noFetch ? {} : { fetchMetricSeries });
    getPlugin.mockResolvedValue(
      opts.noClient
        ? { plugin: { manifest: { id: "pl" } } }
        : { plugin: { manifest: { id: "pl" }, createClient } },
    );

    const { startMetricPinger } = await loadPinger();
    startMetricPinger();
    await flush();
    return { fetchMetricSeries };
  }

  it("fires a notification when the latest value is above range and state changed", async () => {
    await runOneTick({
      pings: [{ ...basePing }],
      series: [{ label: "CPU", unit: "%", points: [{ value: 95 }] }],
    });
    const notif = invoke.mock.calls.find((c) => c[0] === "show_notification");
    expect(notif).toBeTruthy();
    expect((notif![1] as { title: string }).title).toContain("above range");
    // updates last_alert_state
    const upd = execute.mock.calls.find((c) => String(c[0]).includes("last_alert_at"));
    expect(upd![1]).toEqual(["above", "ping-1"]);
  });

  it("fires a below-range notification with a >= range string", async () => {
    await runOneTick({
      pings: [{ ...basePing, min_value: 10, max_value: null }],
      series: [{ label: "CPU", points: [{ value: 2 }] }],
    });
    const notif = invoke.mock.calls.find((c) => c[0] === "show_notification");
    expect((notif![1] as { title: string }).title).toContain("below range");
    expect((notif![1] as { body: string }).body).toContain("≥ 10");
  });

  it("formats a min–max range when both bounds are set", async () => {
    await runOneTick({
      pings: [{ ...basePing, min_value: 10, max_value: 20 }],
      series: [{ label: "CPU", points: [{ value: 30 }] }],
    });
    const notif = invoke.mock.calls.find((c) => c[0] === "show_notification");
    expect((notif![1] as { body: string }).body).toContain("10–20");
  });

  it("does not re-notify when the alert state is unchanged", async () => {
    await runOneTick({
      pings: [{ ...basePing, last_alert_state: "above" }],
      series: [{ label: "CPU", points: [{ value: 95 }] }],
    });
    expect(invoke.mock.calls.find((c) => c[0] === "show_notification")).toBeFalsy();
  });

  it("resets a stale alert state to ok when value returns in range", async () => {
    await runOneTick({
      pings: [{ ...basePing, last_alert_state: "above" }],
      series: [{ label: "CPU", points: [{ value: 10 }] }],
    });
    const upd = execute.mock.calls.find(
      (c) => String(c[0]).includes("last_alert_state = $1") && (c[1] as unknown[])[0] === "ok",
    );
    expect(upd).toBeTruthy();
    expect(invoke.mock.calls.find((c) => c[0] === "show_notification")).toBeFalsy();
  });

  it("does nothing when there is no matching series point", async () => {
    await runOneTick({
      pings: [{ ...basePing }],
      series: [{ label: "OTHER", points: [{ value: 95 }] }],
    });
    expect(invoke.mock.calls.find((c) => c[0] === "show_notification")).toBeFalsy();
  });

  it("skips an account whose credentials fail to load", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runOneTick({ pings: [{ ...basePing }], credentialsThrows: true });
    expect(getPlugin).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("skips when the plugin has no fetchMetricSeries", async () => {
    await runOneTick({ pings: [{ ...basePing }], noFetch: true });
    expect(invoke.mock.calls.find((c) => c[0] === "show_notification")).toBeFalsy();
  });

  it("skips when the plugin cannot create a client", async () => {
    await runOneTick({ pings: [{ ...basePing }], noClient: true });
    expect(invoke.mock.calls.find((c) => c[0] === "show_notification")).toBeFalsy();
  });

  it("returns early when there are no pings", async () => {
    const { fetchMetricSeries } = await runOneTick({ pings: [] });
    expect(fetchMetricSeries).not.toHaveBeenCalled();
  });
});
