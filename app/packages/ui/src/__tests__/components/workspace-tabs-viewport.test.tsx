import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkspaceTabsViewport } from "../../workspace/WorkspaceTabsViewport.js";
import { WorkspaceTabProvider, useTabId } from "../../workspace/WorkspaceTabContext.js";
import { useUIStore, type WorkspaceTab } from "../../store/ui.store.js";
import { renderHook } from "@testing-library/react";

const tabs: WorkspaceTab[] = [
  { id: "t1", target: { kind: "account", accountId: "a1" }, title: "Tab 1" },
  { id: "t2", target: { kind: "account", accountId: "a2" }, title: "Tab 2" },
];

beforeEach(() => {
  useUIStore.setState({ workspaceTabs: tabs, activeWorkspaceTabId: "t1" });
});

describe("WorkspaceTabsViewport", () => {
  it("renders a panel for every tab, showing only the active one", () => {
    render(<WorkspaceTabsViewport renderTabPanel={(tab) => <div>panel-{tab.id}</div>} />);
    const active = screen.getByText("panel-t1").parentElement!;
    const inactive = screen.getByText("panel-t2").parentElement!;
    expect(active.style.display).toBe("flex");
    expect(inactive.style.display).toBe("none");
  });

  it("hides all panels when showActive is false", () => {
    render(
      <WorkspaceTabsViewport
        showActive={false}
        renderTabPanel={(tab) => <div>panel-{tab.id}</div>}
      />,
    );
    expect(screen.getByText("panel-t1").parentElement!.style.display).toBe("none");
  });

  it("provides each panel its own tab id via context", () => {
    function Probe() {
      return <span>id:{useTabId()}</span>;
    }
    render(<WorkspaceTabsViewport renderTabPanel={() => <Probe />} />);
    expect(screen.getByText("id:t1")).toBeInTheDocument();
    expect(screen.getByText("id:t2")).toBeInTheDocument();
  });
});

describe("useTabId", () => {
  it("falls back to the active workspace tab id when outside a provider", () => {
    const { result } = renderHook(() => useTabId());
    expect(result.current).toBe("t1");
  });

  it("returns the provider's tab id when wrapped", () => {
    const { result } = renderHook(() => useTabId(), {
      wrapper: ({ children }) => (
        <WorkspaceTabProvider tabId="provided">{children}</WorkspaceTabProvider>
      ),
    });
    expect(result.current).toBe("provided");
  });
});
