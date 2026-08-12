import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dashboardTabTarget,
  accountTabTarget,
  costReportsTabTarget,
  invoicesTabTarget,
  postureTabTarget,
  accessReviewTabTarget,
  backupsTabTarget,
  iacTabTarget,
  environmentDiffTabTarget,
  probesTabTarget,
  statusPagesTabTarget,
  incidentsTabTarget,
  environmentsTabTarget,
  resourceTabTarget,
  resourceSshTabTarget,
  resourceSftpTabTarget,
  navigateToWorkspaceTarget,
} from "../workspace-tabs";
import {
  getWorkspaceTabFallbackTitle,
  getWorkspaceTabId,
  useUIStore,
  workspaceTabTargetsEqual,
} from "../store/ui.store";

describe("tab target factories", () => {
  it("dashboardTabTarget", () => {
    expect(dashboardTabTarget("main")).toEqual({ kind: "dashboard", dashboardId: "main" });
  });

  it("accountTabTarget", () => {
    expect(accountTabTarget("acc-1")).toEqual({ kind: "account", accountId: "acc-1" });
  });

  it("backupsTabTarget", () => {
    expect(backupsTabTarget()).toEqual({ kind: "backups" });
  });

  it("postureTabTarget", () => {
    expect(postureTabTarget()).toEqual({ kind: "posture" });
  });

  it("accessReviewTabTarget", () => {
    expect(accessReviewTabTarget()).toEqual({ kind: "access-review" });
  });

  it("iacTabTarget", () => {
    expect(iacTabTarget()).toEqual({ kind: "iac" });
  });

  it("environmentDiffTabTarget carries the pair when given, and omits it otherwise", () => {
    expect(environmentDiffTabTarget()).toEqual({ kind: "environment-diff" });
    expect(environmentDiffTabTarget("acc-a", "acc-b")).toEqual({
      kind: "environment-diff",
      a: "acc-a",
      b: "acc-b",
    });
  });

  it("environmentsTabTarget", () => {
    expect(environmentsTabTarget()).toEqual({ kind: "environments" });
  });

  it("probesTabTarget", () => {
    expect(probesTabTarget()).toEqual({ kind: "probes" });
  });

  it("statusPagesTabTarget", () => {
    expect(statusPagesTabTarget()).toEqual({ kind: "status-pages" });
  });

  it("incidentsTabTarget omits incidentId for the list view", () => {
    expect(incidentsTabTarget()).toEqual({ kind: "incidents" });
    expect(incidentsTabTarget("inc-1")).toEqual({ kind: "incidents", incidentId: "inc-1" });
  });

  it("costReportsTabTarget omits reportId for the list view", () => {
    expect(costReportsTabTarget()).toEqual({ kind: "cost-reports" });
    expect(costReportsTabTarget("r1")).toEqual({ kind: "cost-reports", reportId: "r1" });
  });

  it("invoicesTabTarget omits invoiceId for the list view", () => {
    expect(invoicesTabTarget()).toEqual({ kind: "invoices" });
    expect(invoicesTabTarget("inv-1")).toEqual({ kind: "invoices", invoiceId: "inv-1" });
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

/**
 * The single-tab-with-remembered-state pattern, as used by Deploy and
 * Settings: one tab id regardless of the state field, but the field IS
 * compared, so the route sync records it and reactivating the tab restores it.
 * Getting either half wrong is silent — a tab per report, or a report that
 * vanishes on reload.
 */
describe("cost-reports tab identity", () => {
  it("uses one tab id whatever report is open", () => {
    expect(getWorkspaceTabId(costReportsTabTarget())).toBe("cost-reports");
    expect(getWorkspaceTabId(costReportsTabTarget("r1"))).toBe("cost-reports");
  });

  it("has a fallback title", () => {
    expect(getWorkspaceTabFallbackTitle(costReportsTabTarget())).toBe("Reports");
  });

  it("compares the report so the route sync retargets the open tab", () => {
    expect(workspaceTabTargetsEqual(costReportsTabTarget("r1"), costReportsTabTarget("r1"))).toBe(
      true,
    );
    expect(workspaceTabTargetsEqual(costReportsTabTarget("r1"), costReportsTabTarget("r2"))).toBe(
      false,
    );
    expect(workspaceTabTargetsEqual(costReportsTabTarget(), costReportsTabTarget("r1"))).toBe(
      false,
    );
  });

  it("is never equal to another kind", () => {
    expect(workspaceTabTargetsEqual(costReportsTabTarget(), { kind: "costs" })).toBe(false);
  });
});

describe("invoices tab identity", () => {
  it("uses one tab id whatever invoice is open", () => {
    expect(getWorkspaceTabId(invoicesTabTarget())).toBe("invoices");
    expect(getWorkspaceTabId(invoicesTabTarget("inv-1"))).toBe("invoices");
  });

  it("has a fallback title matching both sidebars' label", () => {
    expect(getWorkspaceTabFallbackTitle(invoicesTabTarget())).toBe("Invoices");
  });

  it("compares the invoice so the route sync retargets the open tab", () => {
    expect(workspaceTabTargetsEqual(invoicesTabTarget("i1"), invoicesTabTarget("i1"))).toBe(true);
    expect(workspaceTabTargetsEqual(invoicesTabTarget("i1"), invoicesTabTarget("i2"))).toBe(false);
    expect(workspaceTabTargetsEqual(invoicesTabTarget(), invoicesTabTarget("i1"))).toBe(false);
  });

  it("is never equal to another kind", () => {
    expect(workspaceTabTargetsEqual(invoicesTabTarget(), { kind: "cost-reports" })).toBe(false);
  });
});
