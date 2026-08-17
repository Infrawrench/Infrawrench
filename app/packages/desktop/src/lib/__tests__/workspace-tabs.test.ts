import { describe, it, expect, vi } from "vitest";
import {
  dashboardTabTarget,
  accountTabTarget,
  costReportsTabTarget,
  invoicesTabTarget,
  deploymentsTabTarget,
  probesTabTarget,
  statusPagesTabTarget,
  quotasTabTarget,
  incidentsTabTarget,
  workflowsTabTarget,
  environmentsTabTarget,
  resourceTabTarget,
  resourceSshTabTarget,
  resourceSftpTabTarget,
  resourceAppsTabTarget,
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

  it("returns probes route args", () => {
    const args = getWorkspaceNavigateArgs(probesTabTarget());
    expect(args.to).toBe("/probes");
  });

  it("returns status-pages route args", () => {
    const args = getWorkspaceNavigateArgs(statusPagesTabTarget());
    expect(args.to).toBe("/status-pages");
  });

  it("returns quotas route args", () => {
    const args = getWorkspaceNavigateArgs(quotasTabTarget());
    expect(args.to).toBe("/quotas");
  });

  it("returns incidents route args, clearing the param for the list view", () => {
    const list = getWorkspaceNavigateArgs(incidentsTabTarget());
    expect(list.to).toBe("/incidents");
    // Explicitly empty, not omitted: navigating back from an incident must
    // clear ?incident= or the route resolves straight back into it.
    expect(list.search).toEqual({});

    const detail = getWorkspaceNavigateArgs(incidentsTabTarget("inc-1"));
    expect(detail.to).toBe("/incidents");
    expect(detail.search).toEqual({ incident: "inc-1" });
  });

  it("returns workflows route args, clearing the param for the list view", () => {
    const list = getWorkspaceNavigateArgs(workflowsTabTarget());
    expect(list.to).toBe("/workflows");
    expect(list.search).toEqual({});

    const detail = getWorkspaceNavigateArgs(workflowsTabTarget("wf-1"));
    expect(detail.to).toBe("/workflows");
    expect(detail.search).toEqual({ workflow: "wf-1" });
  });

  it("returns environments route args", () => {
    const args = getWorkspaceNavigateArgs(environmentsTabTarget());
    expect(args.to).toBe("/environments");
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

  it("returns resource route args with the apps hash", () => {
    const args = getWorkspaceNavigateArgs(resourceAppsTabTarget("acc-1", "res-1"));
    expect(args.hash).toBe("apps");
  });

  it("routes a window tab to its resource with the window in the query", () => {
    // A window has no URL of its own worth having: without a live session
    // there is nothing at it, and it belongs to the host either way.
    const args = getWorkspaceNavigateArgs({
      kind: "linux-app",
      accountId: "acc-1",
      resourceId: "res-1",
      sessionId: "sess-9",
      windowId: 4,
      appId: "firefox.desktop",
      pluginId: "hetzner",
      resourceTypeId: "server",
    });
    expect(args).toMatchObject({
      to: "/resource/$accountId/$resourceId",
      hash: "window",
      // The plugin and the type ride along for the same reason a resource tab
      // carries them: the route resolves the resource from the query, and a
      // window tab that dropped them would rebuild itself as one it cannot
      // find.
      search: {
        // A number, not a string: the router JSON-encodes search values, so
        // "4" reaches the URL as %224%22 and reads back out of the query
        // string with its quotes on.
        window: 4,
        session: "sess-9",
        app: "firefox.desktop",
        plugin: "hetzner",
        type: "server",
      },
    });
  });

  it("reads a window id back whether or not the router quoted it", () => {
    for (const raw of ["window=4", "window=%224%22"]) {
      const result = syncWorkspaceRouteFromPath(
        "/resource/acc-1/res-1",
        "#window",
        `?session=sess-9&${raw}`,
      );
      expect(result).toMatchObject({ kind: "linux-app", windowId: 4 });
    }
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

  it("returns wallboard route args", () => {
    expect(getWorkspaceNavigateArgs({ kind: "wallboard" })).toEqual({ to: "/wallboard" });
  });

  it("returns calendar route args", () => {
    expect(getWorkspaceNavigateArgs({ kind: "calendar" })).toEqual({ to: "/calendar" });
  });

  it("returns runbooks route args", () => {
    expect(getWorkspaceNavigateArgs({ kind: "runbooks" })).toEqual({ to: "/runbooks" });
  });

  it("returns query-monitors route args", () => {
    expect(getWorkspaceNavigateArgs({ kind: "query-monitors" })).toEqual({ to: "/query-monitors" });
  });

  it("returns backups route args", () => {
    expect(getWorkspaceNavigateArgs({ kind: "backups" })).toEqual({ to: "/backups" });
  });

  it("returns posture route args", () => {
    expect(getWorkspaceNavigateArgs({ kind: "posture" })).toEqual({ to: "/posture" });
  });

  it("returns access review route args", () => {
    expect(getWorkspaceNavigateArgs({ kind: "access-review" })).toEqual({ to: "/access-review" });
  });

  it("returns dns route args", () => {
    expect(getWorkspaceNavigateArgs({ kind: "dns" })).toEqual({ to: "/dns" });
  });

  it("returns iac route args", () => {
    expect(getWorkspaceNavigateArgs({ kind: "iac" })).toEqual({ to: "/iac" });
  });

  it("carries the environment diff pair as search params", () => {
    expect(getWorkspaceNavigateArgs({ kind: "environment-diff" })).toEqual({
      to: "/environment-diff",
    });
    expect(getWorkspaceNavigateArgs({ kind: "environment-diff", a: "acc-a", b: "acc-b" })).toEqual({
      to: "/environment-diff",
      search: { a: "acc-a", b: "acc-b" },
    });
  });

  it("carries a hotlinked repo through as a search param", () => {
    expect(getWorkspaceNavigateArgs(deploymentsTabTarget("owner/name"))).toEqual({
      to: "/deployments",
      search: { repo: "owner/name" },
    });
  });

  it("returns cost-reports route args, clearing the report param for the list", () => {
    // Same reason as settings/chat: navigating back to the list must CLEAR
    // ?report=, or the route resolves straight back into the open report.
    expect(getWorkspaceNavigateArgs(costReportsTabTarget())).toEqual({
      to: "/cost-reports",
      search: {},
    });
    expect(getWorkspaceNavigateArgs(costReportsTabTarget("r1"))).toEqual({
      to: "/cost-reports",
      search: { report: "r1" },
    });
  });

  it("returns invoices route args, clearing the invoice param for the list", () => {
    // Same reason as cost-reports: navigating back to the list must CLEAR
    // ?invoice=, or the route resolves straight back into the open invoice.
    expect(getWorkspaceNavigateArgs(invoicesTabTarget())).toEqual({
      to: "/invoices",
      search: {},
    });
    expect(getWorkspaceNavigateArgs(invoicesTabTarget("i1"))).toEqual({
      to: "/invoices",
      search: { invoice: "i1" },
    });
  });

  it("returns settings route args, clearing the section param for General", () => {
    expect(getWorkspaceNavigateArgs({ kind: "settings" })).toEqual({
      to: "/settings",
      search: {},
    });
    expect(getWorkspaceNavigateArgs({ kind: "settings", section: "team" })).toEqual({
      to: "/settings",
      search: { section: "team" },
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

  it("parses the wallboard path", () => {
    expect(syncWorkspaceRouteFromPath("/wallboard")).toEqual({ kind: "wallboard" });
  });

  it("parses the calendar path", () => {
    expect(syncWorkspaceRouteFromPath("/calendar")).toEqual({ kind: "calendar" });
  });

  it("parses the runbooks path", () => {
    expect(syncWorkspaceRouteFromPath("/runbooks")).toEqual({ kind: "runbooks" });
  });

  it("parses the query-monitors path", () => {
    expect(syncWorkspaceRouteFromPath("/query-monitors")).toEqual({ kind: "query-monitors" });
  });

  it("parses the backups path", () => {
    expect(syncWorkspaceRouteFromPath("/backups")).toEqual({ kind: "backups" });
  });

  it("parses the posture path", () => {
    expect(syncWorkspaceRouteFromPath("/posture")).toEqual({ kind: "posture" });
  });

  it("parses the access review path", () => {
    expect(syncWorkspaceRouteFromPath("/access-review")).toEqual({ kind: "access-review" });
  });

  it("parses the dns path", () => {
    expect(syncWorkspaceRouteFromPath("/dns")).toEqual({ kind: "dns" });
  });

  it("parses the iac path", () => {
    expect(syncWorkspaceRouteFromPath("/iac")).toEqual({ kind: "iac" });
  });

  it("parses the probes path", () => {
    expect(syncWorkspaceRouteFromPath("/probes")).toEqual({ kind: "probes" });
  });

  it("parses the status-pages path", () => {
    expect(syncWorkspaceRouteFromPath("/status-pages")).toEqual({ kind: "status-pages" });
  });

  it("parses the quotas path", () => {
    expect(syncWorkspaceRouteFromPath("/quotas")).toEqual({ kind: "quotas" });
  });

  it("parses the incidents path, with and without a selected incident", () => {
    expect(syncWorkspaceRouteFromPath("/incidents")).toEqual({ kind: "incidents" });
    expect(syncWorkspaceRouteFromPath("/incidents", undefined, "?incident=inc-1")).toEqual({
      kind: "incidents",
      incidentId: "inc-1",
    });
  });

  it("parses the workflows path, with and without a selected workflow", () => {
    expect(syncWorkspaceRouteFromPath("/workflows")).toEqual({ kind: "workflows" });
    expect(syncWorkspaceRouteFromPath("/workflows", undefined, "?workflow=wf-1")).toEqual({
      kind: "workflows",
      workflowId: "wf-1",
    });
  });

  it("parses the environments path", () => {
    expect(syncWorkspaceRouteFromPath("/environments")).toEqual({ kind: "environments" });
  });

  it("parses the environment diff path, with and without a pair", () => {
    expect(syncWorkspaceRouteFromPath("/environment-diff")).toEqual({ kind: "environment-diff" });
    expect(syncWorkspaceRouteFromPath("/environment-diff", undefined, "a=acc-a&b=acc-b")).toEqual({
      kind: "environment-diff",
      a: "acc-a",
      b: "acc-b",
    });
  });

  it("parses the cost-reports path with its report param", () => {
    expect(syncWorkspaceRouteFromPath("/cost-reports")).toEqual({ kind: "cost-reports" });
    expect(syncWorkspaceRouteFromPath("/cost-reports", undefined, "report=r1")).toEqual({
      kind: "cost-reports",
      reportId: "r1",
    });
  });

  it("parses the invoices path with its invoice param", () => {
    expect(syncWorkspaceRouteFromPath("/invoices")).toEqual({ kind: "invoices" });
    expect(syncWorkspaceRouteFromPath("/invoices", undefined, "invoice=i1")).toEqual({
      kind: "invoices",
      invoiceId: "i1",
    });
  });

  it("parses the settings path with its section param", () => {
    expect(syncWorkspaceRouteFromPath("/settings")).toEqual({ kind: "settings" });
    expect(syncWorkspaceRouteFromPath("/settings", undefined, "section=billing")).toEqual({
      kind: "settings",
      section: "billing",
    });
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

  it("parses resource paths with the apps hash", () => {
    // The launcher is a view of the host, so it round-trips through the same
    // route as SSH and SFTP rather than needing one of its own.
    const result = syncWorkspaceRouteFromPath("/resource/acc-1/res-1", "#apps");
    expect(result).toMatchObject({ kind: "resource", view: "apps" });
  });

  it("parses a window tab back out of its URL", () => {
    const result = syncWorkspaceRouteFromPath(
      "/resource/acc-1/res-1",
      "#window",
      "?window=4&session=sess-9&app=firefox.desktop",
    );
    expect(result).toMatchObject({
      kind: "linux-app",
      accountId: "acc-1",
      resourceId: "res-1",
      sessionId: "sess-9",
      windowId: 4,
      appId: "firefox.desktop",
    });
  });

  it("recovers the plugin and type from a window URL", () => {
    const result = syncWorkspaceRouteFromPath(
      "/resource/acc-1/res-1",
      "#window",
      "?window=4&session=sess-9&plugin=hetzner&type=server",
    );
    expect(result).toMatchObject({
      kind: "linux-app",
      pluginId: "hetzner",
      resourceTypeId: "server",
    });
  });

  it("answers null for a window id without the session it belongs to", () => {
    // Half an address is a transient inconsistency (mid-navigation, the hash
    // can be ahead of the query string), not a request for the resource page.
    // Demoting to the resource detail here is what replaced a freshly
    // launched app's tab with the VM info page.
    expect(syncWorkspaceRouteFromPath("/resource/acc-1/res-1", "#window", "?window=4")).toBeNull();
    expect(syncWorkspaceRouteFromPath("/resource/acc-1/res-1", "#window")).toBeNull();
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
    expect(syncWorkspaceRouteFromPath("/moment")).toBeNull();
  });

  it("returns null for incomplete paths", () => {
    expect(syncWorkspaceRouteFromPath("/dashboard")).toBeNull();
    expect(syncWorkspaceRouteFromPath("/accounts")).toBeNull();
    expect(syncWorkspaceRouteFromPath("/resource/acc-1")).toBeNull();
  });
});
