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
  getWorkspaceNavigateArgs,
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
    expect(syncWorkspaceRouteFromPath("/settings")).toBeNull();
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
