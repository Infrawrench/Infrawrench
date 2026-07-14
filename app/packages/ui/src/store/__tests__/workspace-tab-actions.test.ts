import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUIStore, type WorkspaceTab, type WorkspaceTabTarget } from "../ui.store";

// Mock crypto.randomUUID for deterministic instance IDs
vi.stubGlobal("crypto", { randomUUID: () => "test-uuid" });

function resetStore() {
  useUIStore.setState({
    workspaceTabs: [],
    activeWorkspaceTabId: null,
    tabsHydrated: false,
  });
}

const dashboardTarget: WorkspaceTabTarget = { kind: "dashboard", dashboardId: "main" };
const accountTarget: WorkspaceTabTarget = { kind: "account", accountId: "acc-1" };
const resourceTarget: WorkspaceTabTarget = {
  kind: "resource",
  accountId: "acc-1",
  resourceId: "res-1",
};

describe("openInActiveWorkspaceTab", () => {
  beforeEach(resetStore);

  it("creates a tab when none exist", () => {
    useUIStore.getState().openInActiveWorkspaceTab(dashboardTarget, "Home");
    const { workspaceTabs, activeWorkspaceTabId } = useUIStore.getState();
    expect(workspaceTabs).toHaveLength(1);
    expect(workspaceTabs[0]!.target).toEqual(dashboardTarget);
    expect(workspaceTabs[0]!.title).toBe("Home");
    expect(activeWorkspaceTabId).toBe(workspaceTabs[0]!.id);
  });

  it("reuses the active tab by replacing it", () => {
    useUIStore.getState().openInActiveWorkspaceTab(dashboardTarget, "Home");
    useUIStore.getState().openInActiveWorkspaceTab(accountTarget, "My Account");
    const { workspaceTabs } = useUIStore.getState();
    expect(workspaceTabs).toHaveLength(1);
    expect(workspaceTabs[0]!.target).toEqual(accountTarget);
  });

  it("activates an existing tab with matching target instead of replacing", () => {
    useUIStore.getState().pinWorkspaceTab(dashboardTarget, "Home");
    useUIStore.getState().pinWorkspaceTab(accountTarget, "Acc");
    useUIStore.getState().openInActiveWorkspaceTab(dashboardTarget, "Home Updated");
    const { workspaceTabs, activeWorkspaceTabId } = useUIStore.getState();
    expect(workspaceTabs).toHaveLength(2);
    expect(activeWorkspaceTabId).toBe("dashboard:main");
  });
});

describe("pinWorkspaceTab", () => {
  beforeEach(resetStore);

  it("inserts a new tab after the active tab", () => {
    useUIStore.getState().pinWorkspaceTab(dashboardTarget, "Home");
    useUIStore.getState().pinWorkspaceTab(accountTarget, "Acc");
    // Activate first tab, then pin a new one
    useUIStore.getState().activateWorkspaceTab("dashboard:main");
    useUIStore.getState().pinWorkspaceTab(resourceTarget, "Res");
    const { workspaceTabs } = useUIStore.getState();
    expect(workspaceTabs).toHaveLength(3);
    // Resource should be after dashboard (index 0) at index 1
    expect(workspaceTabs[1]!.target.kind).toBe("resource");
  });

  it("activates the existing tab if target already exists", () => {
    useUIStore.getState().pinWorkspaceTab(dashboardTarget, "Home");
    useUIStore.getState().pinWorkspaceTab(accountTarget, "Acc");
    useUIStore.getState().pinWorkspaceTab(dashboardTarget, "Home Again");
    const { workspaceTabs, activeWorkspaceTabId } = useUIStore.getState();
    expect(workspaceTabs).toHaveLength(2);
    expect(activeWorkspaceTabId).toBe("dashboard:main");
  });

  it("refreshes metadata on an existing matching tab", () => {
    useUIStore.getState().pinWorkspaceTab(
      {
        kind: "resource",
        accountId: "acc-1",
        resourceId: "vm-1",
        view: "ssh",
        agentSessionId: "session-1",
      },
      "SSH",
    );

    useUIStore.getState().pinWorkspaceTab(
      {
        kind: "resource",
        accountId: "acc-1",
        resourceId: "vm-1",
        view: "ssh",
        agentSessionId: "session-1",
        sshKeyId: "agent-key-1",
        sshKeyName: "infrawrench-agent",
        initialCommand: "codex",
        initialCwd: "~/app",
      },
      "codex · app",
    );

    const { workspaceTabs, activeWorkspaceTabId } = useUIStore.getState();
    expect(workspaceTabs).toHaveLength(1);
    expect(activeWorkspaceTabId).toBe("resource:acc-1:vm-1:ssh:agent:session-1");
    expect(workspaceTabs[0]!.title).toBe("codex · app");
    expect(workspaceTabs[0]!.target).toMatchObject({
      kind: "resource",
      view: "ssh",
      agentSessionId: "session-1",
      sshKeyId: "agent-key-1",
      sshKeyName: "infrawrench-agent",
      initialCommand: "codex",
      initialCwd: "~/app",
    });
  });

  it("keeps agent SSH tabs distinct from ordinary SSH tabs", () => {
    useUIStore.getState().pinWorkspaceTab(
      {
        kind: "resource",
        accountId: "acc-1",
        resourceId: "vm-1",
        view: "ssh",
        agentSessionId: "session-1",
        initialCommand: "codex",
        initialCwd: "~/app",
      },
      "codex",
    );
    useUIStore
      .getState()
      .pinWorkspaceTab(
        { kind: "resource", accountId: "acc-1", resourceId: "vm-1", view: "ssh" },
        "SSH",
      );
    const { workspaceTabs } = useUIStore.getState();
    expect(workspaceTabs).toHaveLength(2);
    expect(workspaceTabs[0]!.id).toBe("resource:acc-1:vm-1:ssh:agent:session-1");
    expect(workspaceTabs[1]!.id).toBe("resource:acc-1:vm-1:ssh");
  });

  it("preserves agent SSH launch metadata when route sync omits transient fields", () => {
    useUIStore.getState().createWorkspaceTabInstance(
      {
        kind: "resource",
        accountId: "acc-1",
        resourceId: "vm-1",
        view: "ssh",
        pluginId: "digitalocean",
        resourceTypeId: "droplet",
        agentSessionId: "session-1",
        sshKeyId: "agent-key-1",
        sshKeyName: "infrawrench-agent",
        initialCommand: "codex --yolo",
        initialCwd: "~/infrawrench",
      },
      "codex · test",
    );

    useUIStore.getState().syncWorkspaceRoute({
      kind: "resource",
      accountId: "acc-1",
      resourceId: "vm-1",
      view: "ssh",
      agentSessionId: "session-1",
      sshKeyId: "agent-key-1",
      sshKeyName: "infrawrench-agent",
    });

    const tab = useUIStore.getState().workspaceTabs[0]!;
    expect(tab.title).toBe("codex · test");
    expect(tab.target).toMatchObject({
      pluginId: "digitalocean",
      resourceTypeId: "droplet",
      initialCommand: "codex --yolo",
      initialCwd: "~/infrawrench",
    });
  });
});

describe("createWorkspaceTabInstance", () => {
  beforeEach(resetStore);

  it("creates a tab with a unique instance ID", () => {
    useUIStore.getState().createWorkspaceTabInstance(dashboardTarget, "Home");
    const { workspaceTabs } = useUIStore.getState();
    expect(workspaceTabs).toHaveLength(1);
    expect(workspaceTabs[0]!.id).toBe("dashboard:main::test-uuid");
    expect(workspaceTabs[0]!.title).toBe("Home");
  });

  it("inserts after active tab", () => {
    useUIStore.getState().pinWorkspaceTab(dashboardTarget, "Home");
    useUIStore.getState().pinWorkspaceTab(accountTarget, "Acc");
    useUIStore.getState().activateWorkspaceTab("dashboard:main");
    useUIStore.getState().createWorkspaceTabInstance(resourceTarget, "Res");
    const { workspaceTabs } = useUIStore.getState();
    expect(workspaceTabs[1]!.id).toContain("resource:");
  });
});

describe("closeWorkspaceTab", () => {
  beforeEach(resetStore);

  it("activates the next tab when closing the active tab", () => {
    useUIStore.getState().pinWorkspaceTab(dashboardTarget, "Home");
    useUIStore.getState().pinWorkspaceTab(accountTarget, "Acc");
    useUIStore.getState().activateWorkspaceTab("dashboard:main");
    useUIStore.getState().closeWorkspaceTab("dashboard:main");
    const { workspaceTabs, activeWorkspaceTabId } = useUIStore.getState();
    expect(workspaceTabs).toHaveLength(1);
    expect(activeWorkspaceTabId).toBe("account:acc-1");
  });

  it("activates the previous tab when closing the last tab in the list", () => {
    useUIStore.getState().pinWorkspaceTab(dashboardTarget, "Home");
    useUIStore.getState().pinWorkspaceTab(accountTarget, "Acc");
    // active is now account (last pinned)
    useUIStore.getState().closeWorkspaceTab("account:acc-1");
    const { activeWorkspaceTabId } = useUIStore.getState();
    expect(activeWorkspaceTabId).toBe("dashboard:main");
  });

  it("sets active to null when closing the only tab", () => {
    useUIStore.getState().pinWorkspaceTab(dashboardTarget, "Home");
    useUIStore.getState().closeWorkspaceTab("dashboard:main");
    const { workspaceTabs, activeWorkspaceTabId } = useUIStore.getState();
    expect(workspaceTabs).toHaveLength(0);
    expect(activeWorkspaceTabId).toBeNull();
  });

  it("does nothing for unknown tab id", () => {
    useUIStore.getState().pinWorkspaceTab(dashboardTarget, "Home");
    useUIStore.getState().closeWorkspaceTab("nonexistent");
    expect(useUIStore.getState().workspaceTabs).toHaveLength(1);
  });
});

describe("reorderWorkspaceTabs", () => {
  beforeEach(resetStore);

  it("swaps tab positions", () => {
    useUIStore.getState().pinWorkspaceTab(dashboardTarget, "Home");
    useUIStore.getState().pinWorkspaceTab(accountTarget, "Acc");
    useUIStore.getState().reorderWorkspaceTabs("account:acc-1", "dashboard:main");
    const { workspaceTabs } = useUIStore.getState();
    expect(workspaceTabs[0]!.id).toBe("account:acc-1");
    expect(workspaceTabs[1]!.id).toBe("dashboard:main");
  });

  it("does nothing when activeId equals overId", () => {
    useUIStore.getState().pinWorkspaceTab(dashboardTarget, "Home");
    useUIStore.getState().reorderWorkspaceTabs("dashboard:main", "dashboard:main");
    expect(useUIStore.getState().workspaceTabs).toHaveLength(1);
  });
});

describe("replaceWorkspaceTabs", () => {
  beforeEach(resetStore);

  it("deduplicates tabs by id", () => {
    const tab: WorkspaceTab = {
      id: "dashboard:main",
      target: dashboardTarget,
      title: "Home",
    };
    useUIStore.getState().replaceWorkspaceTabs([tab, tab]);
    expect(useUIStore.getState().workspaceTabs).toHaveLength(1);
  });

  it("sets activeTabId to first tab if provided id is not found", () => {
    const tab: WorkspaceTab = {
      id: "dashboard:main",
      target: dashboardTarget,
      title: "Home",
    };
    useUIStore.getState().replaceWorkspaceTabs([tab], "nonexistent");
    expect(useUIStore.getState().activeWorkspaceTabId).toBe("dashboard:main");
  });
});

describe("removeWorkspaceTabs", () => {
  beforeEach(resetStore);

  it("removes specified tabs and falls back to first remaining", () => {
    useUIStore.getState().pinWorkspaceTab(dashboardTarget, "Home");
    useUIStore.getState().pinWorkspaceTab(accountTarget, "Acc");
    // active is account
    useUIStore.getState().removeWorkspaceTabs(["account:acc-1"]);
    const { workspaceTabs, activeWorkspaceTabId } = useUIStore.getState();
    expect(workspaceTabs).toHaveLength(1);
    expect(activeWorkspaceTabId).toBe("dashboard:main");
  });

  it("sets active to null when all tabs removed", () => {
    useUIStore.getState().pinWorkspaceTab(dashboardTarget, "Home");
    useUIStore.getState().removeWorkspaceTabs(["dashboard:main"]);
    expect(useUIStore.getState().activeWorkspaceTabId).toBeNull();
  });

  it("does nothing for empty tabIds array", () => {
    useUIStore.getState().pinWorkspaceTab(dashboardTarget, "Home");
    useUIStore.getState().removeWorkspaceTabs([]);
    expect(useUIStore.getState().workspaceTabs).toHaveLength(1);
  });
});
