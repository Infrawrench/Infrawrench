import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DefaultDashboardResolution } from "@infrawrench/client-core";

import {
  DashboardDefaultMenu,
  type DashboardDefaultClient,
} from "../components/dashboard/DashboardDefaultMenu.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const base: DefaultDashboardResolution = {
  dashboardId: "home",
  dashboardName: "Home",
  source: "org",
  userDefaultDashboardId: null,
  roleDefault: null,
  orgDefaultDashboardId: "home",
  skipped: [],
};

function clientWith(initial: DefaultDashboardResolution): DashboardDefaultClient {
  return {
    getDefault: vi.fn(async () => initial),
    setMine: vi.fn(async (dashboardId: string) => ({
      ...initial,
      dashboardId,
      source: "user" as const,
      userDefaultDashboardId: dashboardId,
    })),
    clearMine: vi.fn(async () => ({ ...initial, userDefaultDashboardId: null })),
  };
}

describe("DashboardDefaultMenu", () => {
  it("offers to set this dashboard as the viewer's default", async () => {
    const client = clientWith(base);
    const onChanged = vi.fn();
    render(<DashboardDefaultMenu dashboardId="prod" client={client} onChanged={onChanged} />);
    fireEvent.click(await screen.findByText("Default"));
    expect(screen.getByText("You land on Home when you open the app.")).toBeTruthy();
    // Nothing of the viewer's own to clear yet.
    expect(screen.queryByText("Clear my default")).toBeNull();
    fireEvent.click(screen.getByText("Set as my default"));
    await waitFor(() => expect(client.setMine).toHaveBeenCalledWith("prod"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("explains a role default and offers to clear the viewer's own pick", async () => {
    const client = clientWith({
      ...base,
      dashboardId: "fin",
      source: "role",
      roleDefault: { roleId: "r1", roleName: "Finance", dashboardId: "fin" },
      userDefaultDashboardId: "gone",
      skipped: ["user"],
    });
    render(<DashboardDefaultMenu dashboardId="fin" client={client} />);
    fireEvent.click(await screen.findByText("★ Default"));
    expect(
      screen.getByText(
        "You land here when you open the app: it is the default for your role, Finance.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/no longer shared with you/)).toBeTruthy();
    fireEvent.click(screen.getByText("Clear my default"));
    await waitFor(() => expect(client.clearMine).toHaveBeenCalled());
  });

  it("renders nothing when the resolution cannot be read", async () => {
    const client: DashboardDefaultClient = {
      getDefault: vi.fn(async () => {
        throw new Error("older server");
      }),
      setMine: vi.fn(),
      clearMine: vi.fn(),
    };
    const { container } = render(<DashboardDefaultMenu dashboardId="d" client={client} />);
    await waitFor(() => expect(client.getDefault).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});
