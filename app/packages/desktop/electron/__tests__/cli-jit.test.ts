import { describe, expect, it, vi } from "vitest";

// `cli/args` reaches `cli/context` for CliError, which pulls the Electron app
// object and the plugin host at import time. None of it runs here.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { parseCliArgs } from "../cli/args";
import { parseDurationMinutes } from "../cli/commands/jit";

describe("infrawrench jit", () => {
  it("parses the request flags into the jit group", () => {
    const parsed = parseCliArgs([
      "jit",
      "request",
      "--policy",
      "prod",
      "--role",
      "Admin",
      "--scope",
      "payments",
      "--for",
      "2h",
      "--reason",
      "Rolling back INC-42",
      "--ticket",
      "INC-42",
    ]);
    expect(parsed.positionals).toEqual(["jit", "request"]);
    expect(parsed.jit).toMatchObject({
      policy: "prod",
      role: "Admin",
      scope: "payments",
      duration: "2h",
      ticket: "INC-42",
    });
    expect(parsed.flags.reason).toBe("Rolling back INC-42");
  });

  it("reads queue filters", () => {
    const parsed = parseCliArgs(["jit", "--mine", "--holding", "--status", "active"]);
    expect(parsed.jit).toMatchObject({ mine: true, holding: true, status: "active" });
  });

  it("parses durations in minutes or hours", () => {
    expect(parseDurationMinutes("90", "--for")).toBe(90);
    expect(parseDurationMinutes("45m", "--for")).toBe(45);
    expect(parseDurationMinutes("2h", "--for")).toBe(120);
    expect(parseDurationMinutes("1.5h", "--for")).toBe(90);
    expect(() => parseDurationMinutes("soon", "--for")).toThrow(/30m or 2h/);
    expect(() => parseDurationMinutes("1.5m", "--for")).toThrow(/whole number/);
  });
});
