import { describe, it, expect } from "vitest";

import { agentLaunchLookupKey, resolveEffectiveAgentLaunch } from "../agent-launch";

const baseLookupParams = {
  isSshView: true,
  accountId: "acct-1",
  resourceId: "vm-1",
  agentSessionId: "sess-1",
  sshKeyId: undefined,
  sshKeyName: undefined,
  initialCommand: undefined,
  initialCwd: undefined,
};

describe("agentLaunchLookupKey", () => {
  it("returns a key when an agent SSH tab is missing launch metadata", () => {
    expect(agentLaunchLookupKey(baseLookupParams)).toBe("acct-1:vm-1:sess-1");
  });

  it("returns a key when only part of the metadata is present", () => {
    expect(
      agentLaunchLookupKey({
        ...baseLookupParams,
        sshKeyId: "key-1",
        sshKeyName: "infrawrench-agent",
      }),
    ).toBe("acct-1:vm-1:sess-1");
  });

  it("returns null for plain SSH views without an agent session", () => {
    expect(agentLaunchLookupKey({ ...baseLookupParams, agentSessionId: undefined })).toBeNull();
  });

  it("returns null outside the SSH view even for agent sessions", () => {
    expect(agentLaunchLookupKey({ ...baseLookupParams, isSshView: false })).toBeNull();
  });

  it("returns null when all launch metadata is already present", () => {
    expect(
      agentLaunchLookupKey({
        ...baseLookupParams,
        sshKeyId: "key-1",
        sshKeyName: "infrawrench-agent",
        initialCommand: "screen -r agent",
        initialCwd: "~/workspace",
      }),
    ).toBeNull();
  });
});

const baseResolveParams = {
  agentSessionId: "sess-1",
  sshKeyId: undefined,
  sshKeyName: undefined,
  initialCommand: undefined,
  initialCwd: undefined,
  defaults: {},
  resolving: false,
  failed: false,
};

describe("resolveEffectiveAgentLaunch", () => {
  it("is immediately ready for plain SSH tabs (no agent session)", () => {
    const result = resolveEffectiveAgentLaunch({
      ...baseResolveParams,
      agentSessionId: undefined,
    });
    expect(result.autoConnectReady).toBe(true);
    expect(result.sshKeyId).toBeUndefined();
    expect(result.initialCommand).toBeUndefined();
  });

  it("is not ready while resolving", () => {
    const result = resolveEffectiveAgentLaunch({ ...baseResolveParams, resolving: true });
    expect(result.autoConnectReady).toBe(false);
  });

  it("is not ready when an agent session still lacks command/cwd", () => {
    const result = resolveEffectiveAgentLaunch(baseResolveParams);
    expect(result.autoConnectReady).toBe(false);
  });

  it("merges server-resolved defaults and becomes ready", () => {
    const result = resolveEffectiveAgentLaunch({
      ...baseResolveParams,
      defaults: {
        sshKeyId: "key-1",
        sshKeyName: "infrawrench-agent",
        initialCommand: "screen -r agent",
        initialCwd: "~/workspace",
      },
    });
    expect(result).toEqual({
      agentSessionId: "sess-1",
      sshKeyId: "key-1",
      sshKeyName: "infrawrench-agent",
      initialCommand: "screen -r agent",
      initialCwd: "~/workspace",
      autoConnectReady: true,
    });
  });

  it("prefers tab-provided metadata over defaults", () => {
    const result = resolveEffectiveAgentLaunch({
      ...baseResolveParams,
      sshKeyId: "key-tab",
      initialCommand: "screen -r tab",
      defaults: {
        sshKeyId: "key-default",
        sshKeyName: "default-name",
        initialCommand: "screen -r default",
        initialCwd: "~/default",
      },
    });
    expect(result.sshKeyId).toBe("key-tab");
    expect(result.sshKeyName).toBe("default-name");
    expect(result.initialCommand).toBe("screen -r tab");
    expect(result.initialCwd).toBe("~/default");
    expect(result.autoConnectReady).toBe(true);
  });

  it("drops all agent fields and falls back to quick connect on failure", () => {
    const result = resolveEffectiveAgentLaunch({
      ...baseResolveParams,
      sshKeyId: "key-tab",
      sshKeyName: "tab-name",
      initialCommand: "screen -r tab",
      initialCwd: "~/tab",
      failed: true,
    });
    expect(result).toEqual({
      agentSessionId: undefined,
      sshKeyId: undefined,
      sshKeyName: undefined,
      initialCommand: undefined,
      initialCwd: undefined,
      autoConnectReady: true,
    });
  });
});
