import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWorkspaceTabHandlers } from "../../hooks/useWorkspaceTabHandlers.js";
import { useUIStore, type WorkspaceTabTarget } from "../../store/ui.store.js";

const navArgs = (target: WorkspaceTabTarget, replace?: boolean) => ({
  to: `/route/${target.kind}`,
  ...(replace ? { replace: true } : {}),
});

beforeEach(() => {
  useUIStore.setState({ workspaceTabs: [], activeWorkspaceTabId: null });
});

describe("useWorkspaceTabHandlers", () => {
  it("activates a tab and navigates to it", () => {
    act(() => {
      useUIStore.getState().pinWorkspaceTab({ kind: "account", accountId: "a1" }, "Acc 1");
      useUIStore.getState().pinWorkspaceTab({ kind: "account", accountId: "a2" }, "Acc 2");
    });
    const navigate = vi.fn();
    const { result } = renderHook(() => useWorkspaceTabHandlers(navigate, navArgs));
    const firstTabId = useUIStore.getState().workspaceTabs[0]!.id;
    act(() => result.current.handleActivateTab(firstTabId));
    expect(useUIStore.getState().activeWorkspaceTabId).toBe(firstTabId);
    expect(navigate).toHaveBeenCalledWith({ to: "/route/account" });
  });

  it("ignores activation of an unknown tab", () => {
    const navigate = vi.fn();
    const { result } = renderHook(() => useWorkspaceTabHandlers(navigate, navArgs));
    act(() => result.current.handleActivateTab("does-not-exist"));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("navigates to the next tab after closing the active one", () => {
    act(() => {
      useUIStore.getState().pinWorkspaceTab({ kind: "account", accountId: "a1" }, "Acc 1");
      useUIStore.getState().pinWorkspaceTab({ kind: "account", accountId: "a2" }, "Acc 2");
    });
    const tabs = useUIStore.getState().workspaceTabs;
    act(() => useUIStore.getState().activateWorkspaceTab(tabs[1]!.id));
    const navigate = vi.fn();
    const { result } = renderHook(() => useWorkspaceTabHandlers(navigate, navArgs));
    act(() => result.current.handleCloseTab(tabs[1]!.id));
    expect(navigate).toHaveBeenCalled();
  });

  it("navigates home when the last tab is closed", () => {
    act(() => {
      useUIStore.getState().pinWorkspaceTab({ kind: "account", accountId: "a1" }, "Acc 1");
    });
    const onlyTab = useUIStore.getState().workspaceTabs[0]!;
    act(() => useUIStore.getState().activateWorkspaceTab(onlyTab.id));
    const navigate = vi.fn();
    const { result } = renderHook(() => useWorkspaceTabHandlers(navigate, navArgs));
    act(() => result.current.handleCloseTab(onlyTab.id));
    expect(navigate).toHaveBeenCalledWith({ to: "/", replace: true });
  });

  it("closing a non-active tab does not navigate", () => {
    act(() => {
      useUIStore.getState().pinWorkspaceTab({ kind: "account", accountId: "a1" }, "Acc 1");
      useUIStore.getState().pinWorkspaceTab({ kind: "account", accountId: "a2" }, "Acc 2");
    });
    const tabs = useUIStore.getState().workspaceTabs;
    act(() => useUIStore.getState().activateWorkspaceTab(tabs[0]!.id));
    const navigate = vi.fn();
    const { result } = renderHook(() => useWorkspaceTabHandlers(navigate, navArgs));
    act(() => result.current.handleCloseTab(tabs[1]!.id));
    expect(navigate).not.toHaveBeenCalled();
  });
});
