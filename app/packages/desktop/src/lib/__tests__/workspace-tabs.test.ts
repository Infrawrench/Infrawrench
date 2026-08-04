import { describe, it, expect, vi } from "vitest";
import {
  dashboardTabTarget,
  accountTabTarget,
  deploymentsTabTarget,
  resourceTabTarget,
  resourceSshTabTarget,
  resourceSftpTabTarget,
  getWorkspaceNavigateArgs,
  syncWorkspaceRouteFromPath,
} from "../workspace-tabs";

describe("dashboardTabTarget", () => {
  it("returns a dashboard target", () => {
    expect(dashboardTabTarget("dash-1")).toEqual({
      kind: "dashboard",
      dashboardId: "dash-1",
    });
  });
});

describe("accountTabTarget", () => {
  it("returns an account target", () => {
    expect(accountTabTarget("acc-1")).toEqual({
      kind: "account",
      accountId: "acc-1",
    });
  });
});

describe("resourceTabTarget", () => {
  it("returns a resource target with details view", () => {
    const result = resourceTabTarget("acc-1", "res-1");
    expect(result).toEqual({
      kind: "resource",
      accountId: "acc-1",
      resourceId: "res-1",
      view: "details",
    });
  });

  it("decodes URL-encoded resource IDs", () => {
    const result = resourceTabTarget("acc-1", "ns%2Fname");
    expect(result.kind === "resource" && result.resourceId).toBe("ns/name");
  });
});

describe("getWorkspaceNavigateArgs", () => {
  it("returns dashboard route args", () => {
    const args = getWorkspaceNavigateArgs(dashboardTabTarget("dash-1"));
    expect(args.to).toBe("/dashboard/$dashboardId");
    expect(args.params).toEqual({ dashboardId: "dash-1" });
    expect(args.replace).toBeUndefined();
  });

  it("returns account route args", () => {
    const args = getWorkspaceNavigateArgs(accountTabTarget("acc-1"));
    expect(args.to).toBe("/accounts/$accountId");
    expect(args.params).toEqual({ accountId: "acc-1" });
  });

  it("returns resource route args for details view", () => {
    const target = resourceTabTarget("acc-1", "res-1");
    const args = getWorkspaceNavigateArgs(target);
    expect(args.to).toBe("/resource/$accountId/$resourceId");
    expect(args.params?.accountId).toBe("acc-1");
    expect(args.params?.resourceId).toBe(encodeURIComponent("res-1"));
    expect(args.hash).toBeUndefined();
  });

  it("returns resource route args with ssh hash", () => {
    const target = resourceSshTabTarget("acc-1", "res-1");
    const args = getWorkspaceNavigateArgs(target);
    expect(args.hash).toBe("ssh");
  });

  it("includes agent SSH key metadata in resource search params", () => {
    const target = resourceSshTabTarget("acc-1", "res-1", undefined, undefined, {
      agentSessionId: "session-1",
      sshKeyId: "agent-key-1",
      sshKeyName: "infrawrench-agent",
    });
    const args = getWorkspaceNavigateArgs(target);
    expect(args.search).toEqual({
      agentSession: "session-1",
      sshKeyId: "agent-key-1",
      sshKeyName: "infrawrench-agent",
    });
    expect(args.hash).toBe("ssh");
  });

  it("returns resource route args with sftp hash", () => {
    const target = resourceSftpTabTarget("acc-1", "res-1");
    const args = getWorkspaceNavigateArgs(target);
    expect(args.hash).toBe("sftp");
  });

  it("includes plugin/type/parent in search and sets replace for resources", () => {
    const target = {
      kind: "resource" as const,
      accountId: "acc-1",
      resourceId: "res-1",
      view: "details" as const,
      pluginId: "pl",
      resourceTypeId: "rt",
      parentResourceId: "parent-1",
    };
    const args = getWorkspaceNavigateArgs(target, true);
    expect(args.search).toEqual({ plugin: "pl", type: "rt", parent: "parent-1" });
    expect(args.replace).toBe(true);
  });

  it("sets replace when requested", () => {
    const args = getWorkspaceNavigateArgs(dashboardTabTarget("d"), true);
    expect(args.replace).toBe(true);
  });

  it("does not set replace when false", () => {
    const args = getWorkspaceNavigateArgs(dashboardTabTarget("d"), false);
    expect(args.replace).toBeUndefined();
  });

  it("returns deployments route args", () => {
    expect(getWorkspaceNavigateArgs(deploymentsTabTarget())).toEqual({ to: "/deployments" });
  });

  it("returns posture route args", () => {
    expect(getWorkspaceNavigateArgs({ kind: "posture" })).toEqual({ to: "/posture" });
  });

  it("carries a hotlinked repo through as a search param", () => {
    expect(getWorkspaceNavigateArgs(deploymentsTabTarget("owner/name"))).toEqual({
      to: "/deployments",
      search: { repo: "owner/name" },
    });
  });
});

describe("syncWorkspaceRouteFromPath", () => {
  it("returns null for root path", () => {
    expect(syncWorkspaceRouteFromPath("/")).toBeNull();
  });

  it("parses dashboard paths", () => {
    expect(syncWorkspaceRouteFromPath("/dashboard/dash-1")).toEqual({
      kind: "dashboard",
      dashboardId: "dash-1",
    });
  });

  it("parses account paths", () => {
    expect(syncWorkspaceRouteFromPath("/accounts/acc-1")).toEqual({
      kind: "account",
      accountId: "acc-1",
    });
  });

  it("parses the deployments path", () => {
    expect(syncWorkspaceRouteFromPath("/deployments")).toEqual({ kind: "deployments" });
  });

  it("parses the posture path", () => {
    expect(syncWorkspaceRouteFromPath("/posture")).toEqual({ kind: "posture" });
  });

  // Under hash history the query lives inside the fragment, so the repo a
  // /deploy/... hotlink carries only arrives via the router's search string.
  it("parses a deployments path with a repo", () => {
    expect(syncWorkspaceRouteFromPath("/deployments", undefined, "?repo=owner%2Fname")).toEqual({
      kind: "deployments",
      repo: "owner/name",
    });
  });

  it("parses resource paths", () => {
    const result = syncWorkspaceRouteFromPath("/resource/acc-1/res-1");
    expect(result).toMatchObject({
      kind: "resource",
      accountId: "acc-1",
      view: "details",
    });
  });

  it("parses resource paths with ssh hash", () => {
    const result = syncWorkspaceRouteFromPath("/resource/acc-1/res-1", "#ssh");
    expect(result).toMatchObject({
      kind: "resource",
      view: "ssh",
    });
  });

  // The desktop app runs on createHashHistory: the real URL looks like
  // `…/index.html#/resource/acc-1/res-1?agentSession=…#ssh`, so the query
  // string lives inside the hash fragment and window.location.search is
  // ALWAYS empty. Callers pass the router's ParsedLocation.searchStr.
  it("parses agent SSH key metadata from the router search string", () => {
    const result = syncWorkspaceRouteFromPath(
      "/resource/acc-1/res-1",
      "#ssh",
      "?agentSession=session-1&sshKeyId=agent-key-1&sshKeyName=infrawrench-agent",
    );
    expect(result).toMatchObject({
      kind: "resource",
      view: "ssh",
      agentSessionId: "session-1",
      sshKeyId: "agent-key-1",
      sshKeyName: "infrawrench-agent",
    });
  });

  it("omits agent metadata when no search string is passed", () => {
    const result = syncWorkspaceRouteFromPath("/resource/acc-1/res-1", "#ssh");
    expect(result).toMatchObject({ kind: "resource", view: "ssh" });
    expect(result).not.toHaveProperty("agentSessionId");
    expect(result).not.toHaveProperty("sshKeyId");
    expect(result).not.toHaveProperty("sshKeyName");
  });

  it("never reads window.location.search (empty under hash history)", () => {
    // Regression guard: under hash history window.location.search can never
    // contain the router's search params — reading it silently drops agent
    // metadata. Even if something IS in window.location.search, it must not
    // leak into the parsed target.
    vi.stubGlobal("window", {
      location: { search: "?agentSession=leaked-session&sshKeyId=leaked-key" },
    });
    try {
      const result = syncWorkspaceRouteFromPath("/resource/acc-1/res-1", "#ssh");
      expect(result).not.toHaveProperty("agentSessionId");
      expect(result).not.toHaveProperty("sshKeyId");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("parses resource paths with sftp hash", () => {
    const result = syncWorkspaceRouteFromPath("/resource/acc-1/res-1", "#sftp");
    expect(result).toMatchObject({
      kind: "resource",
      view: "sftp",
    });
  });

  it("handles resource IDs with slashes", () => {
    const result = syncWorkspaceRouteFromPath("/resource/acc-1/ns/name");
    expect(result).toMatchObject({
      kind: "resource",
      accountId: "acc-1",
    });
    expect(result).toHaveProperty("resourceId", "ns/name");
  });

  it("returns null for unknown paths", () => {
    expect(syncWorkspaceRouteFromPath("/settings")).toBeNull();
  });

  it("returns null for incomplete paths", () => {
    expect(syncWorkspaceRouteFromPath("/dashboard")).toBeNull();
    expect(syncWorkspaceRouteFromPath("/accounts")).toBeNull();
    expect(syncWorkspaceRouteFromPath("/resource/acc-1")).toBeNull();
  });
});
