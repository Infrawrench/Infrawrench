import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPinWorkspaceTab = vi.fn();
const mockOpenInActiveWorkspaceTab = vi.fn();

// Mock the @infrawrench/ui module before importing the module under test
vi.mock("@infrawrench/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@infrawrench/ui")>();
  return {
    ...actual,
    normalizeResourceId: (id: string) => decodeURIComponent(id),
    useUIStore: {
      getState: () => ({
        pinWorkspaceTab: mockPinWorkspaceTab,
        openInActiveWorkspaceTab: mockOpenInActiveWorkspaceTab,
      }),
    },
  };
});

import {
  dashboardTabTarget,
  accountTabTarget,
  resourceTabTarget,
  resourceSshTabTarget,
  resourceSftpTabTarget,
  costReportsTabTarget,
  invoicesTabTarget,
  workflowsTabTarget,
  getWorkspaceNavigateArgs,
  isRouteHostedTabPanel,
  navigateToWorkspaceTarget,
  syncWorkspaceRouteFromPath,
} from "../workspace-tabs";

// Mock window.location for getWorkspaceNavigateArgs (reads orgId from URL)
beforeEach(() => {
  (globalThis as Record<string, unknown>).window = {
    location: { pathname: "/org/test-org/dashboard/d1", search: "" },
  };
});

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
    expect(args).toEqual({
      to: "/org/$orgId/dashboard/$dashboardId",
      params: { orgId: "test-org", dashboardId: "d1" },
    });
  });

  it("returns account route args", () => {
    const args = getWorkspaceNavigateArgs({ kind: "account", accountId: "a1" });
    expect(args).toEqual({
      to: "/org/$orgId/accounts/$accountId",
      params: { orgId: "test-org", accountId: "a1" },
    });
  });

  it("returns probes route args", () => {
    const args = getWorkspaceNavigateArgs({ kind: "probes" });
    expect(args).toEqual({
      to: "/org/$orgId/probes",
      params: { orgId: "test-org" },
    });
  });

  it("returns status-pages route args", () => {
    const args = getWorkspaceNavigateArgs({ kind: "status-pages" });
    expect(args).toEqual({
      to: "/org/$orgId/status-pages",
      params: { orgId: "test-org" },
    });
  });

  it("returns quotas route args", () => {
    const args = getWorkspaceNavigateArgs({ kind: "quotas" });
    expect(args).toEqual({
      to: "/org/$orgId/quotas",
      params: { orgId: "test-org" },
    });
  });

  it("returns incidents list route args", () => {
    const args = getWorkspaceNavigateArgs({ kind: "incidents" });
    expect(args).toEqual({
      to: "/org/$orgId/incidents",
      params: { orgId: "test-org" },
    });
  });

  it("returns incident detail route args when the tab remembers one", () => {
    const args = getWorkspaceNavigateArgs({ kind: "incidents", incidentId: "inc-1" });
    expect(args).toEqual({
      to: "/org/$orgId/incidents/$incidentId",
      params: { orgId: "test-org", incidentId: "inc-1" },
    });
  });

  it("returns workflows list route args", () => {
    const args = getWorkspaceNavigateArgs({ kind: "workflows" });
    expect(args).toEqual({
      to: "/org/$orgId/workflows",
      params: { orgId: "test-org" },
    });
  });

  it("returns workflow detail route args when the tab remembers one", () => {
    const args = getWorkspaceNavigateArgs({ kind: "workflows", workflowId: "wf-1" });
    expect(args).toEqual({
      to: "/org/$orgId/workflows/$workflowId",
      params: { orgId: "test-org", workflowId: "wf-1" },
    });
  });

  it("returns resource route args with ssh hash (fallback without pluginId)", () => {
    const args = getWorkspaceNavigateArgs({
      kind: "resource",
      accountId: "a1",
      resourceId: "r1",
      view: "ssh",
    });
    expect(args).toMatchObject({
      to: "/org/$orgId/accounts/$accountId",
      params: { orgId: "test-org", accountId: "a1" },
      hash: "ssh",
    });
  });

  it("returns resource route args with ssh hash (with pluginId/resourceTypeId)", () => {
    const args = getWorkspaceNavigateArgs({
      kind: "resource",
      accountId: "a1",
      resourceId: "r1",
      view: "ssh",
      pluginId: "aws",
      resourceTypeId: "ec2-instance",
    });
    expect(args).toMatchObject({
      to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
      params: {
        orgId: "test-org",
        pluginId: "aws",
        resourceTypeId: "ec2-instance",
        resourceId: "r1",
      },
      search: { accountId: "a1" },
      hash: "ssh",
    });
  });

  it("includes agent SSH key metadata in resource search params", () => {
    const args = getWorkspaceNavigateArgs(
      resourceSshTabTarget("a1", "r1", "digitalocean", "droplet", {
        agentSessionId: "session-1",
        sshKeyId: "agent-key-1",
        sshKeyName: "infrawrench-agent",
      }),
    );

    expect(args).toMatchObject({
      to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
      search: {
        accountId: "a1",
        agentSession: "session-1",
        sshKeyId: "agent-key-1",
        sshKeyName: "infrawrench-agent",
      },
      hash: "ssh",
    });
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

  it("returns backups route args", () => {
    expect(getWorkspaceNavigateArgs({ kind: "backups" })).toEqual({
      to: "/org/$orgId/backups",
      params: { orgId: "test-org" },
    });
  });

  it("returns posture route args", () => {
    expect(getWorkspaceNavigateArgs({ kind: "posture" })).toEqual({
      to: "/org/$orgId/posture",
      params: { orgId: "test-org" },
    });
  });

  it("returns access review route args", () => {
    expect(getWorkspaceNavigateArgs({ kind: "access-review" })).toEqual({
      to: "/org/$orgId/access-review",
      params: { orgId: "test-org" },
    });
  });

  it("returns dns route args", () => {
    expect(getWorkspaceNavigateArgs({ kind: "dns" })).toEqual({
      to: "/org/$orgId/dns",
      params: { orgId: "test-org" },
    });
  });

  it("returns iac route args", () => {
    expect(getWorkspaceNavigateArgs({ kind: "iac" })).toEqual({
      to: "/org/$orgId/iac",
      params: { orgId: "test-org" },
    });
  });

  it("carries the environment diff pair as query parameters", () => {
    expect(getWorkspaceNavigateArgs({ kind: "environment-diff" })).toEqual({
      to: "/org/$orgId/environment-diff",
      params: { orgId: "test-org" },
    });
    expect(getWorkspaceNavigateArgs({ kind: "environment-diff", a: "acc-a", b: "acc-b" })).toEqual({
      to: "/org/$orgId/environment-diff",
      params: { orgId: "test-org" },
      search: { a: "acc-a", b: "acc-b" },
    });
  });

  it("returns environments route args", () => {
    expect(getWorkspaceNavigateArgs({ kind: "environments" })).toEqual({
      to: "/org/$orgId/environments",
      params: { orgId: "test-org" },
    });
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

  it("parses org-scoped dashboard path", () => {
    expect(syncWorkspaceRouteFromPath("/org/myorg/dashboard/d1")).toEqual({
      kind: "dashboard",
      dashboardId: "d1",
    });
  });

  it("parses org-scoped accounts path", () => {
    expect(syncWorkspaceRouteFromPath("/org/myorg/accounts/a1")).toEqual({
      kind: "account",
      accountId: "a1",
    });
  });

  it("parses the org-scoped backups path", () => {
    expect(syncWorkspaceRouteFromPath("/org/test-org/backups")).toEqual({ kind: "backups" });
  });

  it("parses the org-scoped posture path", () => {
    expect(syncWorkspaceRouteFromPath("/org/test-org/posture")).toEqual({ kind: "posture" });
  });

  it("parses the org-scoped access review path", () => {
    expect(syncWorkspaceRouteFromPath("/org/test-org/access-review")).toEqual({
      kind: "access-review",
    });
  });

  it("parses the org-scoped dns path", () => {
    expect(syncWorkspaceRouteFromPath("/org/test-org/dns")).toEqual({ kind: "dns" });
  });

  it("parses the org-scoped iac path", () => {
    expect(syncWorkspaceRouteFromPath("/org/test-org/iac")).toEqual({ kind: "iac" });
  });

  it("parses the environment diff path, with and without a pair", () => {
    expect(syncWorkspaceRouteFromPath("/org/test-org/environment-diff", undefined, "")).toEqual({
      kind: "environment-diff",
    });
    expect(
      syncWorkspaceRouteFromPath("/org/test-org/environment-diff", undefined, "?a=acc-a&b=acc-b"),
    ).toEqual({ kind: "environment-diff", a: "acc-a", b: "acc-b" });
  });

  it("parses the environments path", () => {
    expect(syncWorkspaceRouteFromPath("/org/myorg/environments")).toEqual({
      kind: "environments",
    });
  });

  // `/environments` and `/environment-diff` are distinct segments; a prefix
  // match would have swallowed one into the other.
  it("does not confuse environments with the environment diff", () => {
    expect(syncWorkspaceRouteFromPath("/org/myorg/environment-diff", undefined, "")).toEqual({
      kind: "environment-diff",
    });
  });

  it("parses the probes path", () => {
    expect(syncWorkspaceRouteFromPath("/org/myorg/probes")).toEqual({ kind: "probes" });
  });

  it("parses the status-pages path", () => {
    expect(syncWorkspaceRouteFromPath("/org/myorg/status-pages")).toEqual({
      kind: "status-pages",
    });
  });

  it("parses the quotas path", () => {
    expect(syncWorkspaceRouteFromPath("/org/myorg/quotas")).toEqual({ kind: "quotas" });
  });

  it("parses the incidents list path", () => {
    expect(syncWorkspaceRouteFromPath("/org/myorg/incidents")).toEqual({ kind: "incidents" });
  });

  it("parses an incident detail path back onto the same tab", () => {
    expect(syncWorkspaceRouteFromPath("/org/myorg/incidents/inc-1")).toEqual({
      kind: "incidents",
      incidentId: "inc-1",
    });
  });

  it("parses the workflows list path", () => {
    expect(syncWorkspaceRouteFromPath("/org/myorg/workflows")).toEqual({ kind: "workflows" });
  });

  it("parses a workflow detail path back onto the same tab", () => {
    expect(syncWorkspaceRouteFromPath("/org/myorg/workflows/wf-1")).toEqual({
      kind: "workflows",
      workflowId: "wf-1",
    });
  });

  it("parses the chat list path", () => {
    expect(syncWorkspaceRouteFromPath("/org/myorg/chat")).toEqual({ kind: "chat" });
  });

  it("parses a chat conversation path", () => {
    expect(syncWorkspaceRouteFromPath("/org/myorg/chat/c1")).toEqual({
      kind: "chat",
      conversationId: "c1",
    });
  });

  it("parses agent SSH key metadata from resource search params", () => {
    (globalThis as Record<string, unknown>).window = {
      location: {
        pathname: "/org/myorg/resources/digitalocean/droplet/r1",
        search:
          "?accountId=a1&agentSession=session-1&sshKeyId=agent-key-1&sshKeyName=infrawrench-agent",
      },
    };

    expect(
      syncWorkspaceRouteFromPath("/org/myorg/resources/digitalocean/droplet/r1", "#ssh"),
    ).toEqual({
      kind: "resource",
      accountId: "a1",
      resourceId: "r1",
      view: "ssh",
      pluginId: "digitalocean",
      resourceTypeId: "droplet",
      agentSessionId: "session-1",
      sshKeyId: "agent-key-1",
      sshKeyName: "infrawrench-agent",
    });
  });

  it("prefers an explicitly passed search string over window.location", () => {
    const result = syncWorkspaceRouteFromPath(
      "/org/myorg/resources/digitalocean/droplet/r1",
      "#ssh",
      "?accountId=a1&agentSession=session-1",
    );
    expect(result).toMatchObject({
      kind: "resource",
      accountId: "a1",
      view: "ssh",
      agentSessionId: "session-1",
    });
  });

  it("decodes the resource ID exactly once", () => {
    // A resource ID literally containing "%2F" arrives in the path as
    // "%252F"; decoding twice would corrupt it into "/".
    const result = syncWorkspaceRouteFromPath("/org/myorg/resources/p/t/ns%252Fname");
    expect(result).toMatchObject({ kind: "resource", resourceId: "ns%2Fname" });
  });

  it("tolerates a missing window (SSR) when no search string is passed", () => {
    delete (globalThis as Record<string, unknown>).window;
    const result = syncWorkspaceRouteFromPath(
      "/org/myorg/resources/digitalocean/droplet/r1",
      "#ssh",
    );
    expect(result).toMatchObject({ kind: "resource", accountId: "r1", view: "ssh" });
    expect(result).not.toHaveProperty("agentSessionId");
  });

  it("returns null for unknown paths", () => {
    expect(syncWorkspaceRouteFromPath("/moment")).toBeNull();
  });

  it("parses cost-report paths into the single Cost reports tab", () => {
    expect(syncWorkspaceRouteFromPath("/org/myorg/cost-reports")).toEqual({
      kind: "cost-reports",
    });
    expect(syncWorkspaceRouteFromPath("/org/myorg/cost-reports/report-1")).toEqual({
      kind: "cost-reports",
      reportId: "report-1",
    });
  });

  it("parses invoice paths into the single Invoices tab", () => {
    expect(syncWorkspaceRouteFromPath("/org/myorg/invoices")).toEqual({ kind: "invoices" });
    expect(syncWorkspaceRouteFromPath("/org/myorg/invoices/inv-1")).toEqual({
      kind: "invoices",
      invoiceId: "inv-1",
    });
  });

  it("parses settings paths into the single settings tab", () => {
    expect(syncWorkspaceRouteFromPath("/org/myorg/settings")).toEqual({ kind: "settings" });
    expect(syncWorkspaceRouteFromPath("/org/myorg/settings/team")).toEqual({
      kind: "settings",
      section: "team",
    });
    expect(syncWorkspaceRouteFromPath("/org/myorg/settings/ssh-host-keys")).toEqual({
      kind: "settings",
      section: "ssh-host-keys",
    });
  });

  it("returns null for org path without sub-route", () => {
    expect(syncWorkspaceRouteFromPath("/org/myorg")).toBeNull();
  });
});

describe("navigateToWorkspaceTarget", () => {
  it("opens SSH tab as a pinned workspace tab (desktop parity)", () => {
    mockPinWorkspaceTab.mockClear();
    const mockNavigate = vi.fn();

    navigateToWorkspaceTarget(
      mockNavigate,
      resourceSshTabTarget("acct-1", "res-1", "aws", "ec2-instance"),
      { label: "SSH: My EC2", mode: "pin" },
    );

    // Should pin a new tab with the SSH target
    expect(mockPinWorkspaceTab).toHaveBeenCalledWith(
      {
        kind: "resource",
        accountId: "acct-1",
        resourceId: "res-1",
        view: "ssh",
        pluginId: "aws",
        resourceTypeId: "ec2-instance",
      },
      "SSH: My EC2",
    );

    // Should navigate to the resource detail route with hash "ssh"
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
        params: expect.objectContaining({
          pluginId: "aws",
          resourceTypeId: "ec2-instance",
          resourceId: "res-1",
        }),
        hash: "ssh",
      }),
    );
  });

  it("opens SFTP tab as a pinned workspace tab (desktop parity)", () => {
    mockPinWorkspaceTab.mockClear();
    const mockNavigate = vi.fn();

    navigateToWorkspaceTarget(
      mockNavigate,
      resourceSftpTabTarget("acct-1", "res-1", "aws", "ec2-instance"),
      { label: "SFTP: My EC2", mode: "pin" },
    );

    expect(mockPinWorkspaceTab).toHaveBeenCalledWith(
      {
        kind: "resource",
        accountId: "acct-1",
        resourceId: "res-1",
        view: "sftp",
        pluginId: "aws",
        resourceTypeId: "ec2-instance",
      },
      "SFTP: My EC2",
    );

    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
        hash: "sftp",
      }),
    );
  });
});

describe("cost reports tab", () => {
  it("costReportsTabTarget omits reportId for the list view", () => {
    expect(costReportsTabTarget()).toEqual({ kind: "cost-reports" });
    expect(costReportsTabTarget("r1")).toEqual({ kind: "cost-reports", reportId: "r1" });
  });

  it("navigates to the list path without a report and the detail path with one", () => {
    expect(getWorkspaceNavigateArgs(costReportsTabTarget())).toEqual({
      to: "/org/$orgId/cost-reports",
      params: { orgId: "test-org" },
    });
    expect(getWorkspaceNavigateArgs(costReportsTabTarget("r1"))).toEqual({
      to: "/org/$orgId/cost-reports/$reportId",
      params: { orgId: "test-org", reportId: "r1" },
    });
  });

  it("round-trips through the route sync", () => {
    // The URL is what records the open report on the tab, so a target that
    // does not survive this round trip loses the report on reload.
    for (const target of [costReportsTabTarget(), costReportsTabTarget("r1")]) {
      const args = getWorkspaceNavigateArgs(target);
      const path = args.to
        .replace("$orgId", args.params!["orgId"]!)
        .replace("$reportId", args.params!["reportId"] ?? "");
      expect(syncWorkspaceRouteFromPath(path)).toEqual(target);
    }
  });
});

describe("invoices tab", () => {
  it("invoicesTabTarget omits invoiceId for the list view", () => {
    expect(invoicesTabTarget()).toEqual({ kind: "invoices" });
    expect(invoicesTabTarget("i1")).toEqual({ kind: "invoices", invoiceId: "i1" });
  });

  it("navigates to the list path without an invoice and the detail path with one", () => {
    expect(getWorkspaceNavigateArgs(invoicesTabTarget())).toEqual({
      to: "/org/$orgId/invoices",
      params: { orgId: "test-org" },
    });
    expect(getWorkspaceNavigateArgs(invoicesTabTarget("i1"))).toEqual({
      to: "/org/$orgId/invoices/$invoiceId",
      params: { orgId: "test-org", invoiceId: "i1" },
    });
  });

  it("round-trips through the route sync", () => {
    // The URL is what records the open invoice on the tab, so a target that
    // does not survive this round trip loses the invoice on reload.
    for (const target of [invoicesTabTarget(), invoicesTabTarget("i1")]) {
      const args = getWorkspaceNavigateArgs(target);
      const path = args.to
        .replace("$orgId", args.params!["orgId"]!)
        .replace("$invoiceId", args.params!["invoiceId"] ?? "");
      expect(syncWorkspaceRouteFromPath(path)).toEqual(target);
    }
  });
});

describe("workflows tab", () => {
  it("workflowsTabTarget omits workflowId for the list view", () => {
    expect(workflowsTabTarget()).toEqual({ kind: "workflows" });
    expect(workflowsTabTarget("wf-1")).toEqual({ kind: "workflows", workflowId: "wf-1" });
  });

  it("navigates to the list path without a workflow and the detail path with one", () => {
    expect(getWorkspaceNavigateArgs(workflowsTabTarget())).toEqual({
      to: "/org/$orgId/workflows",
      params: { orgId: "test-org" },
    });
    expect(getWorkspaceNavigateArgs(workflowsTabTarget("wf-1"))).toEqual({
      to: "/org/$orgId/workflows/$workflowId",
      params: { orgId: "test-org", workflowId: "wf-1" },
    });
  });

  it("round-trips through the route sync", () => {
    // The URL is what records the open workflow on the tab, so a target that
    // does not survive this round trip loses the workflow on reload — and a
    // leftover /workflows/{id} path with no matching route used to paint
    // TanStack Router's default "Not Found" under the panel.
    for (const target of [workflowsTabTarget(), workflowsTabTarget("wf-1")]) {
      const args = getWorkspaceNavigateArgs(target);
      const path = args.to
        .replace("$orgId", args.params!["orgId"]!)
        .replace("$workflowId", args.params!["workflowId"] ?? "");
      expect(syncWorkspaceRouteFromPath(path)).toEqual(target);
    }
  });
});

describe("isRouteHostedTabPanel", () => {
  const settingsTab = { target: { kind: "settings" } as const };
  const dashboardTab = { target: dashboardTabTarget("d1") };

  it("hands the Settings panel to the layout route while a settings URL is open", () => {
    // The route renders the visible settings UI and carries the tabpanel id;
    // the viewport must not render a second, hidden element with that id.
    for (const path of ["/org/myorg/settings", "/org/myorg/settings/team"]) {
      expect(isRouteHostedTabPanel(syncWorkspaceRouteFromPath(path), settingsTab)).toBe(true);
    }
  });

  it("takes the Settings panel back as soon as the URL leaves settings", () => {
    // The layout route is unmounted here but the tab is still in the strip, so
    // the viewport owes it a panel — otherwise its aria-controls dangles.
    for (const path of ["/org/myorg/dashboard/d1", "/org/myorg/costs", "/onboarding", "/"]) {
      expect(isRouteHostedTabPanel(syncWorkspaceRouteFromPath(path), settingsTab)).toBe(false);
    }
  });

  it("never hands over the panel of any other tab kind", () => {
    expect(
      isRouteHostedTabPanel(syncWorkspaceRouteFromPath("/org/myorg/settings"), dashboardTab),
    ).toBe(false);
  });
});
