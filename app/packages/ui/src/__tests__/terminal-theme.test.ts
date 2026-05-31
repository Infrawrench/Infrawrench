import { describe, expect, it } from "vitest";
import { getTerminalTheme } from "../terminal-theme";
import { getXtermTerminalOptions } from "../xterm-options";

describe("getTerminalTheme", () => {
  it("falls back to default colors when CSS vars are unset", () => {
    const theme = getTerminalTheme();
    expect(theme.background).toBe("#0d0d0d");
    expect(theme.foreground).toBe("#d4d4d4");
    expect(theme.cursor).toBe("#d4d4d4");
    expect(theme.cursorAccent).toBe("#0d0d0d");
    expect(theme.selectionBackground).toBe("#264f78");
  });

  it("reads CSS variables when present", () => {
    document.documentElement.style.setProperty("--color-terminal-bg", "#123456");
    const theme = getTerminalTheme();
    expect(theme.background).toBe("#123456");
    document.documentElement.style.removeProperty("--color-terminal-bg");
  });
});

describe("getXtermTerminalOptions", () => {
  it("returns merged theme with the full ANSI palette and base options", () => {
    const opts = getXtermTerminalOptions();
    expect(opts.theme.background).toBe("#0d0d0d");
    expect(opts.theme.red).toBe("#f44747");
    expect(opts.theme.brightWhite).toBe("#ffffff");
    expect(opts.fontSize).toBe(13);
    expect(opts.cursorStyle).toBe("block");
    expect(opts.scrollback).toBe(10000);
    expect(opts.convertEol).toBe(false);
  });
});
