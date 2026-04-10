import { describe, it, expect, vi } from "vitest";

// Mock the @infrawrench/ui module before importing the module under test
vi.mock("@infrawrench/ui", () => ({
  normalizeResourceId: (id: string) => decodeURIComponent(id),
  useUIStore: { getState: () => ({ pinWorkspaceTab: vi.fn(), openInActiveWorkspaceTab: vi.fn() }) },
}));

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
    expect(dashboardTabTarget("d1")).toEqual({ kind: "dashboard", dashboardId: "d1" });
  });
});

describe("accountTabTarget", () => {
  it("returns an account target", () => {
    expect(accountTabTarget("a1")).toEqual({ kind: "account", accountId: "a1" });
  });
});

describe("resourceTabTarget", () => {
  it("returns a resource target with details view", () => {
    expect(resourceTabTarget("a1", "r1")).toEqual({
      kind: "resource",
      accountId: "a1",
      resourceId: "r1",
      view: "details",
    });
  });
});

describe("resourceSshTabTarget", () => {
  it("returns a resource target with ssh view", () => {
    expect(resourceSshTabTarget("a1", "r1")).toEqual({
      kind: "resource",
      accountId: "a1",
      resourceId: "r1",
      view: "ssh",
    });
  });
});

describe("resourceSftpTabTarget", () => {
  it("returns a resource target with sftp view", () => {
    expect(resourceSftpTabTarget("a1", "r1")).toEqual({
      kind: "resource",
      accountId: "a1",
      resourceId: "r1",
      view: "sftp",
    });
  });
});

describe("getWorkspaceNavigateArgs", () => {
  it("returns dashboard route args", () => {
    const args = getWorkspaceNavigateArgs({ kind: "dashboard", dashboardId: "d1" });
    expect(args).toEqual({ to: "/dashboard/$dashboardId", params: { dashboardId: "d1" } });
  });

  it("returns account route args", () => {
    const args = getWorkspaceNavigateArgs({ kind: "account", accountId: "a1" });
    expect(args).toEqual({ to: "/accounts/$accountId", params: { accountId: "a1" } });
  });

  it("returns resource route args with ssh hash", () => {
    const args = getWorkspaceNavigateArgs({
      kind: "resource",
      accountId: "a1",
      resourceId: "r1",
      view: "ssh",
    });
    expect(args).toMatchObject({ to: "/accounts/$accountId", params: { accountId: "a1" }, hash: "ssh" });
  });

  it("returns resource route args with sftp hash", () => {
    const args = getWorkspaceNavigateArgs({
      kind: "resource",
      accountId: "a1",
      resourceId: "r1",
      view: "sftp",
    });
    expect(args).toMatchObject({ hash: "sftp" });
  });

  it("sets replace when requested", () => {
    const args = getWorkspaceNavigateArgs({ kind: "dashboard", dashboardId: "d1" }, true);
    expect(args.replace).toBe(true);
  });
});

describe("syncWorkspaceRouteFromPath", () => {
  it("returns null for root path", () => {
    expect(syncWorkspaceRouteFromPath("/")).toBeNull();
  });

  it("parses dashboard path", () => {
    expect(syncWorkspaceRouteFromPath("/dashboard/d1")).toEqual({
      kind: "dashboard",
      dashboardId: "d1",
    });
  });

  it("parses accounts path", () => {
    expect(syncWorkspaceRouteFromPath("/accounts/a1")).toEqual({
      kind: "account",
      accountId: "a1",
    });
  });

  it("returns null for unknown paths", () => {
    expect(syncWorkspaceRouteFromPath("/settings")).toBeNull();
  });
});
