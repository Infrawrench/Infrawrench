import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { GlobalTabBar } from "../../components/GlobalTabBar.js";
import { WorkspaceTabsViewport } from "../../workspace/WorkspaceTabsViewport.js";
import { workspaceTabDomId, workspaceTabPanelDomId } from "../../workspace/tab-dom-ids.js";
import { useUIStore, type WorkspaceTab } from "../../store/ui.store.js";

// Ids that exercise what real tab ids look like: `getWorkspaceTabId` builds
// them from targets, so they carry colons, slashes, dots and (via resource
// names) spaces.
const tabs: WorkspaceTab[] = [
  { id: "dashboard:d1", target: { kind: "account", accountId: "a1" }, title: "Dash" },
  {
    id: "resource:acct-1:arn:aws:s3:::my bucket/prod.v2",
    target: { kind: "account", accountId: "a2" },
    title: "Bucket",
  },
  { id: "costs", target: { kind: "costs" }, title: "Costs" },
];

beforeEach(() => {
  useUIStore.setState({ workspaceTabs: tabs, activeWorkspaceTabId: "costs" });
});

/** Renders the shell's tab strip and panel viewport as siblings, as both hosts do. */
function renderShell(
  viewportProps: Partial<React.ComponentProps<typeof WorkspaceTabsViewport>> = {},
) {
  return render(
    <>
      <GlobalTabBar
        tabs={tabs}
        activeTabId={useUIStore.getState().activeWorkspaceTabId}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onNew={vi.fn()}
      />
      <WorkspaceTabsViewport
        renderTabPanel={(tab) => <div>panel-{tab.id}</div>}
        {...viewportProps}
      />
    </>,
  );
}

describe("workspace tab / panel wiring", () => {
  it("resolves every tab's aria-controls to a rendered tabpanel", () => {
    renderShell();
    const tabButtons = screen.getAllByRole("tab");
    expect(tabButtons).toHaveLength(tabs.length);
    for (const button of tabButtons) {
      const panelId = button.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      // An IDREF is whitespace-delimited: a space would silently make this two
      // references, neither of which exists.
      expect(panelId).not.toMatch(/\s/);
      const panel = document.getElementById(panelId!);
      expect(panel, `no element with id ${panelId}`).not.toBeNull();
      expect(panel).toHaveAttribute("role", "tabpanel");
      expect(panel).toHaveAttribute("aria-labelledby", button.id);
    }
  });

  it("keeps the panel element for tabs shouldMountTab excludes, without mounting them", () => {
    renderShell({ shouldMountTab: (tab) => tab.id === "costs" });
    expect(screen.queryByText("panel-dashboard:d1")).not.toBeInTheDocument();
    expect(screen.getByText("panel-costs")).toBeInTheDocument();
    for (const button of screen.getAllByRole("tab")) {
      expect(document.getElementById(button.getAttribute("aria-controls")!)).not.toBeNull();
    }
  });

  it("shows only the active tab's panel", () => {
    renderShell();
    const active = document.getElementById(workspaceTabPanelDomId("costs"))!;
    const inactive = document.getElementById(workspaceTabPanelDomId("dashboard:d1"))!;
    expect(active.style.display).toBe("flex");
    // display:none keeps inactive panels out of the accessibility tree while
    // their React state (SSH sessions, xterm scrollback) stays alive.
    expect(inactive.style.display).toBe("none");
    expect(inactive).toHaveTextContent("panel-dashboard:d1");
  });
});

describe("workspace tab DOM ids", () => {
  it("is stable across independent calls, so the two components agree", () => {
    expect(workspaceTabDomId("costs")).toBe(workspaceTabDomId("costs"));
    expect(workspaceTabPanelDomId("costs")).toBe(workspaceTabPanelDomId("costs"));
  });

  it("never produces whitespace or a leading digit", () => {
    for (const id of ["my bucket", "9lives", "a\tb", ""]) {
      for (const domId of [workspaceTabDomId(id), workspaceTabPanelDomId(id)]) {
        expect(domId).not.toMatch(/\s/);
        expect(domId).toMatch(/^[A-Za-z]/);
      }
    }
  });

  it("distinguishes the tab from its panel", () => {
    expect(workspaceTabDomId("costs")).not.toBe(workspaceTabPanelDomId("costs"));
  });

  it("maps distinct tab ids to distinct DOM ids", () => {
    const ids = [
      "a_62_",
      "ab",
      "a b",
      "a:b",
      "a-b",
      "resource:acct:i-1",
      "resource:acct:i:1",
      "dashboard:d1",
    ];
    const domIds = new Set(ids.map(workspaceTabDomId));
    expect(domIds.size).toBe(ids.length);
  });
});
