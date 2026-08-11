import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { GlobalTabBar } from "../../components/GlobalTabBar.js";
import { WorkspaceTabsViewport } from "../../workspace/WorkspaceTabsViewport.js";
import {
  workspaceTabDomId,
  workspaceTabPanelDomId,
  workspaceTabPanelProps,
} from "../../workspace/tab-dom-ids.js";
import { useUIStore, type WorkspaceTab } from "../../store/ui.store.js";
import type { ReactNode } from "react";

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

/**
 * Renders the shell's tab strip and panel viewport as siblings, as both hosts
 * do. `outlet` stands in for web's `__root` `<Outlet />`, the third sibling
 * where route-rendered content (Settings) draws.
 */
function renderShell(
  viewportProps: Partial<React.ComponentProps<typeof WorkspaceTabsViewport>> = {},
  outlet?: ReactNode,
) {
  const { workspaceTabs, activeWorkspaceTabId } = useUIStore.getState();
  return render(
    <>
      <GlobalTabBar
        tabs={workspaceTabs}
        activeTabId={activeWorkspaceTabId}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onNew={vi.fn()}
      />
      <WorkspaceTabsViewport
        renderTabPanel={(tab) => <div>panel-{tab.id}</div>}
        {...viewportProps}
      />
      {outlet}
    </>,
  );
}

/** Every tab in the strip points at an element that exists and is a tabpanel. */
function expectEveryTabToResolve() {
  const tabButtons = screen.getAllByRole("tab");
  expect(tabButtons.length).toBeGreaterThan(0);
  for (const button of tabButtons) {
    const panelId = button.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    // An IDREF is whitespace-delimited: a space would silently make this two
    // references, neither of which exists.
    expect(panelId).not.toMatch(/\s/);
    expect(document.querySelectorAll(`[id="${panelId}"]`)).toHaveLength(1);
    const panel = document.getElementById(panelId!);
    expect(panel, `no element with id ${panelId}`).not.toBeNull();
    expect(panel).toHaveAttribute("role", "tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", button.id);
  }
  return tabButtons;
}

describe("workspace tab / panel wiring", () => {
  it("resolves every tab's aria-controls to a rendered tabpanel", () => {
    renderShell();
    expect(expectEveryTabToResolve()).toHaveLength(tabs.length);
  });

  it("keeps the panel element for tabs shouldMountTab excludes, without mounting them", () => {
    renderShell({ shouldMountTab: (tab) => tab.id === "costs" });
    expect(screen.queryByText("panel-dashboard:d1")).not.toBeInTheDocument();
    expect(screen.getByText("panel-costs")).toBeInTheDocument();
    expectEveryTabToResolve();
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

// Web's Settings tab: it sits in the strip and reads as selected, but its
// content is rendered by the settings router subtree into __root's <Outlet/>,
// a sibling of the viewport — so the viewport hides every panel it owns
// (showActive=false) and the visible content is outside all of them.
describe("a tab whose panel the host renders (web Settings)", () => {
  const settingsTab: WorkspaceTab = {
    id: "settings",
    target: { kind: "settings" },
    title: "Settings",
  };
  const withSettings = [...tabs, settingsTab];

  beforeEach(() => {
    useUIStore.setState({ workspaceTabs: withSettings, activeWorkspaceTabId: "settings" });
  });

  /** Stands in for the settings layout route, which spreads the panel props. */
  function SettingsRoute() {
    return <div {...workspaceTabPanelProps("settings")}>Session recordings</div>;
  }

  it("points the selected tab at the visible content, not a hidden empty panel", () => {
    renderShell(
      {
        showActive: false,
        panelRenderedByHost: (tab) => tab.target.kind === "settings",
      },
      <SettingsRoute />,
    );

    const selected = screen.getByRole("tab", { name: "Settings" });
    expect(selected).toHaveAttribute("aria-selected", "true");

    const panel = document.getElementById(selected.getAttribute("aria-controls")!)!;
    expect(panel).not.toBeNull();
    // The panel is the route's own element: it holds the settings UI and is
    // visible, so a screen reader following the tab reaches what is on screen.
    expect(panel).toHaveTextContent("Session recordings");
    expect(panel.style.display).not.toBe("none");
    expect(panel).toBeVisible();
  });

  it("renders exactly one element per panel id — no duplicate from the viewport", () => {
    renderShell(
      {
        showActive: false,
        panelRenderedByHost: (tab) => tab.target.kind === "settings",
      },
      <SettingsRoute />,
    );
    expectEveryTabToResolve();
    expect(document.querySelectorAll(`[id="${workspaceTabPanelDomId("settings")}"]`)).toHaveLength(
      1,
    );
  });

  it("renders the panel itself again once the host stops hosting it", () => {
    // Navigating off /settings unmounts the layout route while the tab stays
    // in the strip — the viewport has to take the panel back or the tab
    // controls nothing.
    renderShell({ panelRenderedByHost: () => false });
    expectEveryTabToResolve();
    expect(document.getElementById(workspaceTabPanelDomId("settings"))).toHaveTextContent(
      "panel-settings",
    );
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
