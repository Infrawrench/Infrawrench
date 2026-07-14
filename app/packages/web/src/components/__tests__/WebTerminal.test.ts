import { describe, expect, it } from "vitest";
import { base64EncodeUtf8, buildInitialShellCommand, shellQuote } from "../WebTerminal";

describe("shellQuote", () => {
  it("single-quotes plain paths", () => {
    expect(shellQuote("/srv/app")).toBe("'/srv/app'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("/srv/it's here")).toBe(`'/srv/it'\\''s here'`);
  });

  it("keeps bare ~ unquoted", () => {
    expect(shellQuote("~")).toBe("~");
  });

  it("double-quotes the remainder of simple ~/ paths", () => {
    expect(shellQuote("~/simple")).toBe('~/"simple"');
  });

  it("quotes spaces in ~/ paths so cd does not word-split", () => {
    expect(shellQuote("~/My Project")).toBe('~/"My Project"');
  });

  it("neutralizes semicolons in ~/ paths", () => {
    expect(shellQuote("~/x; rm -rf y")).toBe('~/"x; rm -rf y"');
  });

  it("escapes $ in ~/ paths", () => {
    expect(shellQuote("~/a$b")).toBe('~/"a\\$b"');
  });

  it("escapes backticks in ~/ paths", () => {
    expect(shellQuote("~/a`whoami`b")).toBe('~/"a\\`whoami\\`b"');
  });

  it("escapes double quotes and backslashes in ~/ paths", () => {
    expect(shellQuote('~/a"b\\c')).toBe('~/"a\\"b\\\\c"');
  });

  it("single-quotes paths that only look tilde-ish", () => {
    expect(shellQuote("~user/dir")).toBe("'~user/dir'");
  });
});

describe("buildInitialShellCommand", () => {
  it("returns empty string without a command", () => {
    expect(buildInitialShellCommand(undefined, "~/dir")).toBe("");
    expect(buildInitialShellCommand("  ", "~/dir")).toBe("");
  });

  it("returns the command alone without a cwd", () => {
    expect(buildInitialShellCommand("codex", undefined)).toBe("codex");
    expect(buildInitialShellCommand("codex", "  ")).toBe("codex");
  });

  it("prefixes a quoted cd when cwd is set", () => {
    expect(buildInitialShellCommand("codex", "~/My Project")).toBe('cd ~/"My Project" && codex');
    expect(buildInitialShellCommand("codex", "/srv/app")).toBe("cd '/srv/app' && codex");
  });
});

describe("base64EncodeUtf8", () => {
  it("matches btoa for ASCII input", () => {
    expect(base64EncodeUtf8("cd '/srv/app' && codex\n")).toBe(btoa("cd '/srv/app' && codex\n"));
  });

  it("encodes non-Latin1 characters as UTF-8 instead of throwing", () => {
    const value = "cd ~/\"プロジェクト\" && codex — déjà\n";
    expect(() => btoa(value)).toThrow();
    const encoded = base64EncodeUtf8(value);
    // The server decodes with Buffer.from(data, "base64") and writes raw
    // bytes to the SSH stream, so the round trip must be UTF-8.
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(value);
  });
});
