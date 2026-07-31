import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GlobalTabBar } from "../../components/GlobalTabBar.js";
import type { WorkspaceTab } from "../../store/ui.store.js";

const tabs: WorkspaceTab[] = [
  { id: "t1", target: { kind: "account", accountId: "a1" }, title: "First" },
  { id: "t2", target: { kind: "account", accountId: "a2" }, title: "Second" },
];

function setup(overrides: Partial<React.ComponentProps<typeof GlobalTabBar>> = {}) {
  const props = {
    tabs,
    activeTabId: "t1",
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onNew: vi.fn(),
    ...overrides,
  };
  render(<GlobalTabBar {...props} />);
  return props;
}

describe("GlobalTabBar", () => {
  it("renders nothing when there are no tabs and no empty hint", () => {
    const { container } = render(
      <GlobalTabBar
        tabs={[]}
        activeTabId={null}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onNew={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("stays mounted with no tabs when trailing actions are supplied", () => {
    render(
      <GlobalTabBar
        tabs={[]}
        activeTabId={null}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onNew={vi.fn()}
        trailingActions={<button type="button">Settings</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    // An empty tablist is invalid ARIA, and the "+" button is not a tab.
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("keeps the new-tab button out of the tablist", () => {
    setup();
    expect(screen.getByRole("tablist")).not.toContainElement(
      screen.getByRole("button", { name: "New tab" }),
    );
  });

  it("keeps trailing actions outside the scrolling tab strip", () => {
    setup({ trailingActions: <button type="button">Settings</button> });
    const tablist = screen.getByRole("tablist");
    const settings = screen.getByRole("button", { name: "Settings" });
    expect(tablist).not.toContainElement(settings);
  });

  it("shows the empty hint when enabled and no tabs", () => {
    render(
      <GlobalTabBar
        tabs={[]}
        activeTabId={null}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onNew={vi.fn()}
        showEmptyHint
      />,
    );
    expect(screen.getByText(/Drag dashboards, accounts, or resources/)).toBeInTheDocument();
  });

  it("renders a tab per entry with the correct selected state", () => {
    setup();
    const first = screen.getByRole("tab", { name: "First" });
    const second = screen.getByRole("tab", { name: "Second" });
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(second).toHaveAttribute("aria-selected", "false");
  });

  it("activates a tab on click", () => {
    const { onActivate } = setup();
    fireEvent.click(screen.getByRole("tab", { name: "Second" }));
    expect(onActivate).toHaveBeenCalledWith("t2");
  });

  it("closes a tab via the close button without activating", () => {
    const { onClose, onActivate } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Close tab First" }));
    expect(onClose).toHaveBeenCalledWith("t1");
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("creates a new tab via the + button", () => {
    const { onNew } = setup();
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    expect(onNew).toHaveBeenCalledOnce();
  });

  it("navigates tabs with arrow keys", () => {
    const { onActivate } = setup();
    fireEvent.keyDown(screen.getByRole("tab", { name: "First" }), { key: "ArrowRight" });
    expect(onActivate).toHaveBeenCalledWith("t2");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Second" }), { key: "End" });
    expect(onActivate).toHaveBeenCalledWith("t2");
    fireEvent.keyDown(screen.getByRole("tab", { name: "First" }), { key: "Home" });
    expect(onActivate).toHaveBeenCalledWith("t1");
    fireEvent.keyDown(screen.getByRole("tab", { name: "First" }), { key: "ArrowLeft" });
    expect(onActivate).toHaveBeenCalledWith("t2");
  });

  it("uses a custom tab wrapper when supplied", () => {
    setup({
      renderTabWrapper: (tab, children) => (
        <div key={tab.id} data-testid={`wrap-${tab.id}`}>
          {children}
        </div>
      ),
    });
    expect(screen.getByTestId("wrap-t1")).toBeInTheDocument();
  });
});
