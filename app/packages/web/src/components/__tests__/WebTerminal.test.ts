import { describe, expect, it } from "vitest";
import { base64EncodeUtf8 } from "../WebTerminal";

// shellQuote / buildInitialShellCommand tests live in
// @infrawrench/ui (src/__tests__/terminal-shell.test.ts).

describe("base64EncodeUtf8", () => {
  it("matches btoa for ASCII input", () => {
    expect(base64EncodeUtf8("cd '/srv/app' && codex\n")).toBe(btoa("cd '/srv/app' && codex\n"));
  });

  it("encodes non-Latin1 characters as UTF-8 instead of throwing", () => {
    const value = 'cd ~/"プロジェクト" && codex — déjà\n';
    expect(() => btoa(value)).toThrow();
    const encoded = base64EncodeUtf8(value);
    // The server decodes with Buffer.from(data, "base64") and writes raw
    // bytes to the SSH stream, so the round trip must be UTF-8.
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(value);
  });
});
