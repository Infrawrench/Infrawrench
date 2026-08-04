import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dashboardTabTarget,
  accountTabTarget,
  postureTabTarget,
  resourceTabTarget,
  resourceSshTabTarget,
  resourceSftpTabTarget,
  navigateToWorkspaceTarget,
} from "../workspace-tabs";
import { useUIStore } from "../store/ui.store";

describe("tab target factories", () => {
  it("dashboardTabTarget", () => {
    expect(dashboardTabTarget("main")).toEqual({ kind: "dashboard", dashboardId: "main" });
  });

  it("accountTabTarget", () => {
    expect(accountTabTarget("acc-1")).toEqual({ kind: "account", accountId: "acc-1" });
  });

  it("postureTabTarget", () => {
    expect(postureTabTarget()).toEqual({ kind: "posture" });
  });

  it("resourceTabTarget normalizes id and defaults to details view", () => {
    expect(resourceTabTarget("acc-1", "arn%3Aaws", "aws", "ec2", "parent-1")).toEqual({
      kind: "resource",
      accountId: "acc-1",
      resourceId: "arn:aws",
      view: "details",
      pluginId: "aws",
      resourceTypeId: "ec2",
      parentResourceId: "parent-1",
    });
  });

  it("resourceTabTarget omits optional ids when not provided", () => {
    expect(resourceTabTarget("acc-1", "r")).toEqual({
      kind: "resource",
      accountId: "acc-1",
      resourceId: "r",
      view: "details",
    });
  });

  it("resourceSshTabTarget sets ssh view", () => {
    expect(resourceSshTabTarget("acc-1", "r", "aws", "ec2")).toEqual({
      kind: "resource",
      accountId: "acc-1",
      resourceId: "r",
      view: "ssh",
      pluginId: "aws",
      resourceTypeId: "ec2",
    });
  });

  it("resourceSshTabTarget can carry agent launch metadata", () => {
    expect(
      resourceSshTabTarget("acc-1", "r", "aws", "ec2", {
        agentSessionId: "session-1",
        initialCommand: "codex",
        initialCwd: "~/repo",
      }),
    ).toEqual({
      kind: "resource",
      accountId: "acc-1",
      resourceId: "r",
      view: "ssh",
      pluginId: "aws",
      resourceTypeId: "ec2",
      agentSessionId: "session-1",
      initialCommand: "codex",
      initialCwd: "~/repo",
    });
  });

  it("resourceSftpTabTarget sets sftp view", () => {
    expect(resourceSftpTabTarget("acc-1", "r")).toEqual({
      kind: "resource",
      accountId: "acc-1",
      resourceId: "r",
      view: "sftp",
    });
  });
});

describe("navigateToWorkspaceTarget", () => {
  beforeEach(() => {
    useUIStore.setState({ workspaceTabs: [], activeWorkspaceTabId: null, tabsHydrated: false });
  });

  const getNavigateArgs = (_: unknown, replace?: boolean) => ({
    to: "/dashboard",
    ...(replace ? { replace: true } : {}),
  });

  it("reuse-active mode opens in active tab and navigates", () => {
    const navigate = vi.fn();
    navigateToWorkspaceTarget(navigate, dashboardTabTarget("main"), getNavigateArgs, {
      label: "Home",
    });
    expect(useUIStore.getState().workspaceTabs).toHaveLength(1);
    expect(navigate).toHaveBeenCalledWith({ to: "/dashboard" });
  });

  it("pin mode pins a new tab", () => {
    const navigate = vi.fn();
    navigateToWorkspaceTarget(navigate, accountTabTarget("acc-1"), getNavigateArgs, {
      mode: "pin",
      label: "Acc",
    });
    expect(useUIStore.getState().workspaceTabs).toHaveLength(1);
    expect(useUIStore.getState().workspaceTabs[0]!.title).toBe("Acc");
  });

  it("passes replace through to navigate args", () => {
    const navigate = vi.fn();
    navigateToWorkspaceTarget(navigate, dashboardTabTarget("main"), getNavigateArgs, {
      replace: true,
    });
    expect(navigate).toHaveBeenCalledWith({ to: "/dashboard", replace: true });
  });

  it("works without options (defaults to reuse-active, no label)", () => {
    const navigate = vi.fn();
    navigateToWorkspaceTarget(navigate, dashboardTabTarget("main"), getNavigateArgs);
    expect(useUIStore.getState().workspaceTabs).toHaveLength(1);
    expect(navigate).toHaveBeenCalled();
  });

  it("pin mode without label still pins", () => {
    const navigate = vi.fn();
    navigateToWorkspaceTarget(navigate, accountTabTarget("acc-2"), getNavigateArgs, {
      mode: "pin",
    });
    expect(useUIStore.getState().workspaceTabs).toHaveLength(1);
  });
});
