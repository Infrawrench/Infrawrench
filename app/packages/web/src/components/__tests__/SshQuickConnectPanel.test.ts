import { describe, expect, it } from "vitest";
import { pickQuickConnectKeyId } from "../SshQuickConnectPanel";

const keys = [
  { id: "agent-key-1", name: "infrawrench-agent" },
  { id: "other-key", name: "deploy" },
  { id: "root-key", name: "root" },
];

describe("pickQuickConnectKeyId", () => {
  it("prefers the agent key by id over everything else", () => {
    expect(
      pickQuickConnectKeyId({
        keys,
        previousId: "other-key",
        effectiveUsername: "root",
        preferredSshKeyId: "agent-key-1",
      }),
    ).toBe("agent-key-1");
  });

  it("falls back to matching the preferred key by name", () => {
    expect(
      pickQuickConnectKeyId({
        keys,
        previousId: "other-key",
        effectiveUsername: "root",
        preferredSshKeyId: "missing-id",
        preferredSshKeyName: "infrawrench-agent",
      }),
    ).toBe("agent-key-1");
  });

  it("preserves a previous manual selection when there is no preferred key", () => {
    expect(
      pickQuickConnectKeyId({
        keys,
        previousId: "other-key",
        effectiveUsername: "root",
      }),
    ).toBe("other-key");
  });

  it("matches the username when nothing is selected yet", () => {
    expect(
      pickQuickConnectKeyId({
        keys,
        previousId: null,
        effectiveUsername: "Deploy",
      }),
    ).toBe("other-key");
  });

  it("falls back to the first key when nothing else matches", () => {
    expect(
      pickQuickConnectKeyId({
        keys,
        previousId: null,
        effectiveUsername: "nobody",
      }),
    ).toBe("agent-key-1");
  });

  it("returns the previous selection when the key list is empty", () => {
    expect(
      pickQuickConnectKeyId({ keys: [], previousId: null, effectiveUsername: "root" }),
    ).toBeNull();
    expect(
      pickQuickConnectKeyId({ keys: [], previousId: "other-key", effectiveUsername: "root" }),
    ).toBe("other-key");
  });
});
