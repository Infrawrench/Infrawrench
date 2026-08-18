import { describe, expect, it } from "vitest";
import {
  normalizeResourceId,
  getWorkspaceTabId,
  getWorkspaceTabFallbackTitle,
  workspaceTabTargetsEqual,
  type WorkspaceTabTarget,
} from "../ui.store";

describe("normalizeResourceId", () => {
  it("decodes %3A to colon", () => {
    expect(normalizeResourceId("arn%3Aaws%3Aec2")).toBe("arn:aws:ec2");
  });

  it("is idempotent on already-decoded strings", () => {
    expect(normalizeResourceId("arn:aws:ec2")).toBe("arn:aws:ec2");
  });

  it("handles empty string", () => {
    expect(normalizeResourceId("")).toBe("");
  });

  it("returns original on malformed URI encoding", () => {
    expect(normalizeResourceId("%ZZ")).toBe("%ZZ");
  });

  it("decodes multiple encoded segments", () => {
    expect(normalizeResourceId("a%20b%3Ac")).toBe("a b:c");
  });
});

describe("getWorkspaceTabId", () => {
  it("returns deterministic id for dashboard target", () => {
    expect(getWorkspaceTabId({ kind: "dashboard", dashboardId: "main" })).toBe("dashboard:main");
  });

  it("returns deterministic id for account target", () => {
    expect(getWorkspaceTabId({ kind: "account", accountId: "acc-1" })).toBe("account:acc-1");
  });

  it("returns deterministic id for resource target without view", () => {
    expect(
      getWorkspaceTabId({
        kind: "resource",
        accountId: "acc-1",
        resourceId: "res-1",
      }),
    ).toBe("resource:acc-1:res-1");
  });

  it("distinguishes ssh view", () => {
    expect(
      getWorkspaceTabId({
        kind: "resource",
        accountId: "acc-1",
        resourceId: "res-1",
        view: "ssh",
      }),
    ).toBe("resource:acc-1:res-1:ssh");
  });

  it("distinguishes sftp view", () => {
    expect(
      getWorkspaceTabId({
        kind: "resource",
        accountId: "acc-1",
        resourceId: "res-1",
        view: "sftp",
      }),
    ).toBe("resource:acc-1:res-1:sftp");
  });

  it("normalizes encoded resourceId", () => {
    expect(
      getWorkspaceTabId({
        kind: "resource",
        accountId: "acc-1",
        resourceId: "arn%3Aaws",
      }),
    ).toBe("resource:acc-1:arn:aws");
  });

  it("returns the singleton id for the wallboard target", () => {
    expect(getWorkspaceTabId({ kind: "wallboard" })).toBe("wallboard");
  });

  it("returns the singleton id for the calendar target", () => {
    // Paging through months is a control on the page, not a tab per month.
    expect(getWorkspaceTabId({ kind: "calendar" })).toBe("calendar");
  });

  it("returns the singleton id for the backups target", () => {
    expect(getWorkspaceTabId({ kind: "backups" })).toBe("backups");
  });

  it("returns the singleton id for the posture target", () => {
    expect(getWorkspaceTabId({ kind: "posture" })).toBe("posture");
  });

  it("returns the singleton id for the access review target", () => {
    expect(getWorkspaceTabId({ kind: "access-review" })).toBe("access-review");
  });

  it("returns the singleton id for the iac target", () => {
    expect(getWorkspaceTabId({ kind: "iac" })).toBe("iac");
  });
});

describe("environment diff tab kind", () => {
  it("keys one tab regardless of which pair it is showing", () => {
    expect(getWorkspaceTabId({ kind: "environment-diff" })).toBe("environment-diff");
    expect(getWorkspaceTabId({ kind: "environment-diff", a: "acc-a", b: "acc-b" })).toBe(
      "environment-diff",
    );
  });

  it("falls back to the sidebar tile's title", () => {
    expect(getWorkspaceTabFallbackTitle({ kind: "environment-diff" })).toBe("Env diff");
  });

  // The id is deliberately pair-blind so a second comparison reuses the tab;
  // this comparison is what makes the route sync notice the pair changed.
  it("compares the two accounts so the route sync retargets the tab", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "environment-diff", a: "acc-a", b: "acc-b" },
        { kind: "environment-diff", a: "acc-a", b: "acc-b" },
      ),
    ).toBe(true);
    expect(
      workspaceTabTargetsEqual(
        { kind: "environment-diff", a: "acc-a", b: "acc-b" },
        { kind: "environment-diff", a: "acc-a", b: "acc-c" },
      ),
    ).toBe(false);
    expect(
      workspaceTabTargetsEqual({ kind: "environment-diff" }, { kind: "environment-diff" }),
    ).toBe(true);
  });
});

describe("environments tab kind", () => {
  it("is a singleton tab id", () => {
    expect(getWorkspaceTabId({ kind: "environments" })).toBe("environments");
  });

  it("falls back to the sidebar tile's title", () => {
    expect(getWorkspaceTabFallbackTitle({ kind: "environments" })).toBe("Environments");
  });

  it("compares equal to itself", () => {
    expect(workspaceTabTargetsEqual({ kind: "environments" }, { kind: "environments" })).toBe(true);
  });

  it("is not the environment diff", () => {
    expect(workspaceTabTargetsEqual({ kind: "environments" }, { kind: "environment-diff" })).toBe(
      false,
    );
  });
});

describe("probes tab kind", () => {
  it("is a singleton tab id", () => {
    expect(getWorkspaceTabId({ kind: "probes" })).toBe("probes");
  });

  it("falls back to the sidebar tile's title", () => {
    expect(getWorkspaceTabFallbackTitle({ kind: "probes" })).toBe("Probes");
  });

  it("compares equal to itself", () => {
    expect(workspaceTabTargetsEqual({ kind: "probes" }, { kind: "probes" })).toBe(true);
  });
});

describe("status pages tab kind", () => {
  it("is a singleton tab with the expected title", () => {
    expect(getWorkspaceTabId({ kind: "status-pages" })).toBe("status-pages");
    expect(getWorkspaceTabFallbackTitle({ kind: "status-pages" })).toBe("Status pages");
    expect(workspaceTabTargetsEqual({ kind: "status-pages" }, { kind: "status-pages" })).toBe(true);
  });
});

describe("incidents tab kind", () => {
  it("is a singleton tab id regardless of which incident is open", () => {
    expect(getWorkspaceTabId({ kind: "incidents" })).toBe("incidents");
    expect(getWorkspaceTabId({ kind: "incidents", incidentId: "inc-1" })).toBe("incidents");
  });

  it("falls back to the sidebar tile's title", () => {
    expect(getWorkspaceTabFallbackTitle({ kind: "incidents" })).toBe("Incidents");
  });

  it("compares by incident, so reactivation restores the one that was open", () => {
    expect(workspaceTabTargetsEqual({ kind: "incidents" }, { kind: "incidents" })).toBe(true);
    expect(
      workspaceTabTargetsEqual(
        { kind: "incidents", incidentId: "inc-1" },
        { kind: "incidents", incidentId: "inc-1" },
      ),
    ).toBe(true);
    expect(
      workspaceTabTargetsEqual(
        { kind: "incidents", incidentId: "inc-1" },
        { kind: "incidents", incidentId: "inc-2" },
      ),
    ).toBe(false);
    expect(
      workspaceTabTargetsEqual({ kind: "incidents" }, { kind: "incidents", incidentId: "inc-1" }),
    ).toBe(false);
  });
});

describe("workflows tab kind", () => {
  it("is a singleton tab id regardless of which workflow is open", () => {
    expect(getWorkspaceTabId({ kind: "workflows" })).toBe("workflows");
    expect(getWorkspaceTabId({ kind: "workflows", workflowId: "wf-1" })).toBe("workflows");
  });

  it("falls back to the sidebar tile's title", () => {
    expect(getWorkspaceTabFallbackTitle({ kind: "workflows" })).toBe("Workflows");
  });

  it("compares by workflow, so reactivation restores the one that was open", () => {
    expect(workspaceTabTargetsEqual({ kind: "workflows" }, { kind: "workflows" })).toBe(true);
    expect(
      workspaceTabTargetsEqual(
        { kind: "workflows", workflowId: "wf-1" },
        { kind: "workflows", workflowId: "wf-1" },
      ),
    ).toBe(true);
    expect(
      workspaceTabTargetsEqual(
        { kind: "workflows", workflowId: "wf-1" },
        { kind: "workflows", workflowId: "wf-2" },
      ),
    ).toBe(false);
    expect(
      workspaceTabTargetsEqual({ kind: "workflows" }, { kind: "workflows", workflowId: "wf-1" }),
    ).toBe(false);
  });
});

describe("getWorkspaceTabFallbackTitle", () => {
  it("returns 'Dashboard' for dashboard target", () => {
    expect(getWorkspaceTabFallbackTitle({ kind: "dashboard", dashboardId: "x" })).toBe("Dashboard");
  });

  it("returns 'Account' for account target", () => {
    expect(getWorkspaceTabFallbackTitle({ kind: "account", accountId: "x" })).toBe("Account");
  });

  it("returns 'Resource' for resource target without view", () => {
    expect(
      getWorkspaceTabFallbackTitle({
        kind: "resource",
        accountId: "a",
        resourceId: "r",
      }),
    ).toBe("Resource");
  });

  it("returns 'SSH' for resource target with ssh view", () => {
    expect(
      getWorkspaceTabFallbackTitle({
        kind: "resource",
        accountId: "a",
        resourceId: "r",
        view: "ssh",
      }),
    ).toBe("SSH");
  });

  it("returns 'SFTP' for resource target with sftp view", () => {
    expect(
      getWorkspaceTabFallbackTitle({
        kind: "resource",
        accountId: "a",
        resourceId: "r",
        view: "sftp",
      }),
    ).toBe("SFTP");
  });

  it("returns 'Wallboard' for the wallboard target, matching the sidebar tile", () => {
    expect(getWorkspaceTabFallbackTitle({ kind: "wallboard" })).toBe("Wallboard");
  });

  it("returns 'Calendar' for the calendar target, matching the sidebar tile", () => {
    expect(getWorkspaceTabFallbackTitle({ kind: "calendar" })).toBe("Calendar");
  });

  it("returns 'Backups' for the backups target, matching the sidebar tile", () => {
    expect(getWorkspaceTabFallbackTitle({ kind: "backups" })).toBe("Backups");
  });

  it("returns 'Posture' for the posture target, matching the sidebar tile", () => {
    expect(getWorkspaceTabFallbackTitle({ kind: "posture" })).toBe("Posture");
  });

  it("returns 'Access review' for the access review target, matching the sidebar tile", () => {
    expect(getWorkspaceTabFallbackTitle({ kind: "access-review" })).toBe("Access review");
  });

  it("returns 'IaC' for the iac target, matching the sidebar tile", () => {
    expect(getWorkspaceTabFallbackTitle({ kind: "iac" })).toBe("IaC");
  });
});

describe("workspaceTabTargetsEqual", () => {
  it("returns true for equal dashboard targets", () => {
    const a: WorkspaceTabTarget = { kind: "dashboard", dashboardId: "d1" };
    const b: WorkspaceTabTarget = { kind: "dashboard", dashboardId: "d1" };
    expect(workspaceTabTargetsEqual(a, b)).toBe(true);
  });

  it("returns false for different dashboard ids", () => {
    const a: WorkspaceTabTarget = { kind: "dashboard", dashboardId: "d1" };
    const b: WorkspaceTabTarget = { kind: "dashboard", dashboardId: "d2" };
    expect(workspaceTabTargetsEqual(a, b)).toBe(false);
  });

  it("returns false for different kinds", () => {
    const a: WorkspaceTabTarget = { kind: "dashboard", dashboardId: "d1" };
    const b: WorkspaceTabTarget = { kind: "account", accountId: "d1" };
    expect(workspaceTabTargetsEqual(a, b)).toBe(false);
  });

  it("returns true for equal account targets", () => {
    const a: WorkspaceTabTarget = { kind: "account", accountId: "a1" };
    const b: WorkspaceTabTarget = { kind: "account", accountId: "a1" };
    expect(workspaceTabTargetsEqual(a, b)).toBe(true);
  });

  it("returns true for equal resource targets with same view", () => {
    const a: WorkspaceTabTarget = {
      kind: "resource",
      accountId: "a1",
      resourceId: "r1",
      view: "ssh",
    };
    const b: WorkspaceTabTarget = {
      kind: "resource",
      accountId: "a1",
      resourceId: "r1",
      view: "ssh",
    };
    expect(workspaceTabTargetsEqual(a, b)).toBe(true);
  });

  it("returns false for resource targets with different views", () => {
    const a: WorkspaceTabTarget = {
      kind: "resource",
      accountId: "a1",
      resourceId: "r1",
      view: "ssh",
    };
    const b: WorkspaceTabTarget = {
      kind: "resource",
      accountId: "a1",
      resourceId: "r1",
      view: "sftp",
    };
    expect(workspaceTabTargetsEqual(a, b)).toBe(false);
  });

  it("treats undefined view as 'details'", () => {
    const a: WorkspaceTabTarget = {
      kind: "resource",
      accountId: "a1",
      resourceId: "r1",
    };
    const b: WorkspaceTabTarget = {
      kind: "resource",
      accountId: "a1",
      resourceId: "r1",
      view: "details",
    };
    expect(workspaceTabTargetsEqual(a, b)).toBe(true);
  });

  it("normalizes encoded resource ids for comparison", () => {
    const a: WorkspaceTabTarget = {
      kind: "resource",
      accountId: "a1",
      resourceId: "arn%3Aaws",
      view: "details",
    };
    const b: WorkspaceTabTarget = {
      kind: "resource",
      accountId: "a1",
      resourceId: "arn:aws",
      view: "details",
    };
    expect(workspaceTabTargetsEqual(a, b)).toBe(true);
  });

  it("treats two wallboard targets as equal (singleton tab)", () => {
    expect(workspaceTabTargetsEqual({ kind: "wallboard" }, { kind: "wallboard" })).toBe(true);
  });

  it("treats two calendar targets as equal (singleton tab)", () => {
    expect(workspaceTabTargetsEqual({ kind: "calendar" }, { kind: "calendar" })).toBe(true);
  });

  it("treats two backups targets as equal (singleton tab)", () => {
    expect(workspaceTabTargetsEqual({ kind: "backups" }, { kind: "backups" })).toBe(true);
  });

  it("treats two posture targets as equal (singleton tab)", () => {
    expect(workspaceTabTargetsEqual({ kind: "posture" }, { kind: "posture" })).toBe(true);
  });

  it("treats two access review targets as equal (singleton tab)", () => {
    expect(workspaceTabTargetsEqual({ kind: "access-review" }, { kind: "access-review" })).toBe(
      true,
    );
  });

  // Different kinds must never collapse: Posture and Access review sit next to
  // each other in the sidebar and answer different questions.
  it("never equates the access review with posture", () => {
    expect(workspaceTabTargetsEqual({ kind: "access-review" }, { kind: "posture" })).toBe(false);
  });

  it("treats two iac targets as equal (singleton tab)", () => {
    expect(workspaceTabTargetsEqual({ kind: "iac" }, { kind: "iac" })).toBe(true);
  });
});
