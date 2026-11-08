import { describe, expect, it, vi } from "vitest";

// `commands/jit` reaches `cli/context`, which pulls the Electron app object
// and the plugin host at import time. None of it runs here.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { parseDurationMinutes } from "../cli/commands/jit";

describe("infrawrench jit", () => {
  it("parses durations in minutes or hours", () => {
    expect(parseDurationMinutes("90", "--for")).toBe(90);
    expect(parseDurationMinutes("45m", "--for")).toBe(45);
    expect(parseDurationMinutes("2h", "--for")).toBe(120);
    expect(parseDurationMinutes("1.5h", "--for")).toBe(90);
    expect(() => parseDurationMinutes("soon", "--for")).toThrow(/30m or 2h/);
    expect(() => parseDurationMinutes("1.5m", "--for")).toThrow(/whole number/);
  });
});
