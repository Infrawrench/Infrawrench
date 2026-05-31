import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const loadPlugins = vi.fn();
vi.mock("@infrawrench/server-core/plugin-loader", () => ({
  loadPlugins: (...a: unknown[]) => loadPlugins(...a),
}));

const start = vi.fn();
const stop = vi.fn();
vi.mock("./loop", () => ({
  PollerLoop: vi.fn().mockImplementation(() => ({ start, stop })),
}));

describe("poller index bootstrap", () => {
  let exitSpy: MockInstance<typeof process.exit>;
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    loadPlugins.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    stop.mockResolvedValue(undefined);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((): never => undefined as never) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.useRealTimers();
  });

  it("loads plugins, starts the loop, and registers signal handlers", async () => {
    await import("./index");
    // allow main()'s awaited loadPlugins to resolve
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    expect(loadPlugins).toHaveBeenCalled();
    expect(process.listenerCount("SIGTERM")).toBeGreaterThan(0);
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(0);
  });

  it("drains the loop and exits cleanly on SIGTERM", async () => {
    await import("./index");
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    process.emit("SIGTERM");
    await vi.waitFor(() => expect(stop).toHaveBeenCalled());
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
  });

  it("exits(1) when bootstrap throws", async () => {
    loadPlugins.mockRejectedValue(new Error("cannot load"));
    await import("./index");
    await vi.waitFor(() =>
      expect(errSpy).toHaveBeenCalledWith("[poller] fatal:", expect.any(Error)),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
