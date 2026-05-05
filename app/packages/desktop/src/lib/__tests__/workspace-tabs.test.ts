import { describe, it, expect } from "vitest";
import {
  dashboardTabTarget,
  accountTabTarget,
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

  it("returns resource route args with sftp hash", () => {
    const target = resourceSftpTabTarget("acc-1", "res-1");
    const args = getWorkspaceNavigateArgs(target);
    expect(args.hash).toBe("sftp");
  });

  it("sets replace when requested", () => {
    const args = getWorkspaceNavigateArgs(dashboardTabTarget("d"), true);
    expect(args.replace).toBe(true);
  });

  it("does not set replace when false", () => {
    const args = getWorkspaceNavigateArgs(dashboardTabTarget("d"), false);
    expect(args.replace).toBeUndefined();
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
