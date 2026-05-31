import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useWorkspaceTabDocumentTitle } from "../../hooks/useDocumentTitle.js";
import { useUIStore } from "../../store/ui.store.js";
import type { WorkspaceTab } from "../../store/ui.store.js";

const tab: WorkspaceTab = {
  id: "t1",
  target: { kind: "account", accountId: "a1" },
  title: "My Account",
};

beforeEach(() => {
  useUIStore.setState({ workspaceTabs: [], activeWorkspaceTabId: null });
  document.title = "";
});

describe("useWorkspaceTabDocumentTitle", () => {
  it("sets the app name when no tab is active", () => {
    renderHook(() => useWorkspaceTabDocumentTitle());
    expect(document.title).toBe("Infrawrench");
  });

  it("appends the app name to the active tab title by default", () => {
    useUIStore.setState({ workspaceTabs: [tab], activeWorkspaceTabId: "t1" });
    renderHook(() => useWorkspaceTabDocumentTitle());
    expect(document.title).toBe("My Account | Infrawrench");
  });

  it("uses the bare title when suffix is false", () => {
    useUIStore.setState({ workspaceTabs: [tab], activeWorkspaceTabId: "t1" });
    renderHook(() => useWorkspaceTabDocumentTitle({ suffix: false }));
    expect(document.title).toBe("My Account");
  });
});
