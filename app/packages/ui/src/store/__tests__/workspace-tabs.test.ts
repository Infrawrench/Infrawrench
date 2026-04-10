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
    expect(getWorkspaceTabId({ kind: "dashboard", dashboardId: "main" })).toBe(
      "dashboard:main",
    );
  });

  it("returns deterministic id for account target", () => {
    expect(getWorkspaceTabId({ kind: "account", accountId: "acc-1" })).toBe(
      "account:acc-1",
    );
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
});

describe("getWorkspaceTabFallbackTitle", () => {
  it("returns 'Dashboard' for dashboard target", () => {
    expect(
      getWorkspaceTabFallbackTitle({ kind: "dashboard", dashboardId: "x" }),
    ).toBe("Dashboard");
  });

  it("returns 'Account' for account target", () => {
    expect(
      getWorkspaceTabFallbackTitle({ kind: "account", accountId: "x" }),
    ).toBe("Account");
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
});
