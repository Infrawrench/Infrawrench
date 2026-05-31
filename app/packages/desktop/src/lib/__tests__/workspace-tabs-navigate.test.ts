import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteNavigator } from "@infrawrench/ui";

const pinWorkspaceTab = vi.fn();
const openInActiveWorkspaceTab = vi.fn();

vi.mock("@infrawrench/ui", () => ({
  normalizeResourceId: (id: string) => decodeURIComponent(id),
  useUIStore: { getState: () => ({ pinWorkspaceTab, openInActiveWorkspaceTab }) },
  dashboardTabTarget: (dashboardId: string) => ({ kind: "dashboard", dashboardId }),
  accountTabTarget: (accountId: string) => ({ kind: "account", accountId }),
  resourceTabTarget: (accountId: string, resourceId: string) => ({
    kind: "resource",
    accountId,
    resourceId,
    view: "details",
  }),
  resourceSshTabTarget: (accountId: string, resourceId: string) => ({
    kind: "resource",
    accountId,
    resourceId,
    view: "ssh",
  }),
  resourceSftpTabTarget: (accountId: string, resourceId: string) => ({
    kind: "resource",
    accountId,
    resourceId,
    view: "sftp",
  }),
}));

import {
  navigateToWorkspaceTarget,
  getWorkspaceNavigateArgs,
  dashboardTabTarget,
} from "../workspace-tabs";

beforeEach(() => {
  pinWorkspaceTab.mockReset();
  openInActiveWorkspaceTab.mockReset();
});

describe("navigateToWorkspaceTarget", () => {
  it("opens in the active tab (default reuse-active mode) and navigates", () => {
    const navigate = vi.fn() as unknown as RouteNavigator;
    const target = dashboardTabTarget("d1");
    navigateToWorkspaceTarget(navigate, target);
    expect(openInActiveWorkspaceTab).toHaveBeenCalledWith(target);
    expect(pinWorkspaceTab).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(getWorkspaceNavigateArgs(target, undefined));
  });

  it("opens in the active tab with a label", () => {
    const navigate = vi.fn() as unknown as RouteNavigator;
    const target = dashboardTabTarget("d1");
    navigateToWorkspaceTarget(navigate, target, { label: "Home" });
    expect(openInActiveWorkspaceTab).toHaveBeenCalledWith(target, "Home");
  });

  it("pins the tab in pin mode without a label", () => {
    const navigate = vi.fn() as unknown as RouteNavigator;
    const target = dashboardTabTarget("d1");
    navigateToWorkspaceTarget(navigate, target, { mode: "pin", replace: true });
    expect(pinWorkspaceTab).toHaveBeenCalledWith(target);
    expect(navigate).toHaveBeenCalledWith(getWorkspaceNavigateArgs(target, true));
  });

  it("pins the tab in pin mode with a label", () => {
    const navigate = vi.fn() as unknown as RouteNavigator;
    const target = dashboardTabTarget("d1");
    navigateToWorkspaceTarget(navigate, target, { mode: "pin", label: "Pinned" });
    expect(pinWorkspaceTab).toHaveBeenCalledWith(target, "Pinned");
  });
});

describe("getWorkspaceNavigateArgs unsupported target", () => {
  it("throws for an unknown target kind", () => {
    expect(() => getWorkspaceNavigateArgs({ kind: "nope" } as never)).toThrow(
      /Unsupported workspace tab target/,
    );
  });
});
