import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../invoke";

describe("invoke", () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    // Restore whatever window was (likely undefined in node env).
    if (originalWindow === undefined) {
      // @ts-expect-error - test cleanup
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  });

  it("rejects when the preload bridge is missing", async () => {
    // @ts-expect-error - simulate no preload
    globalThis.window = {};
    await expect(invoke("db_select")).rejects.toThrow(/preload script not loaded/);
  });

  it("rejects when the channel is not exposed by the bridge", async () => {
    // @ts-expect-error - test stub
    globalThis.window = { electronAPI: {} };
    await expect(invoke("not_a_channel")).rejects.toThrow(/is not exposed by the preload bridge/);
  });

  it("dispatches to the per-channel preload method and returns its result", async () => {
    const dbSelect = vi.fn().mockResolvedValue([{ id: "1" }]);
    // @ts-expect-error - test stub
    globalThis.window = { electronAPI: { db_select: dbSelect } };

    const result = await invoke<{ id: string }[]>("db_select", { sql: "SELECT 1" });

    expect(dbSelect).toHaveBeenCalledWith({ sql: "SELECT 1" });
    expect(result).toEqual([{ id: "1" }]);
  });

  it("passes undefined args through when none are supplied", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    // @ts-expect-error - test stub
    globalThis.window = { electronAPI: { some_channel: fn } };

    await invoke("some_channel");

    expect(fn).toHaveBeenCalledWith(undefined);
  });

  it("rejects when the channel value is not a function", async () => {
    // @ts-expect-error - test stub
    globalThis.window = { electronAPI: { weird: 123 } };
    await expect(invoke("weird")).rejects.toThrow(/is not exposed/);
  });
});
