import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AppLauncherPanel } from "../apps/AppLauncherPanel.js";
import type { AppEntry } from "@infrawrench/appstream-core";

const apps: AppEntry[] = [
  { id: "gimp.desktop", name: "GIMP", comment: "Image editor" },
  { id: "vim.desktop", name: "Vim", needsTerminal: true },
];

describe("AppLauncherPanel", () => {
  it("launches the entry that was clicked", () => {
    const onLaunch = vi.fn();
    render(<AppLauncherPanel apps={apps} onLaunch={onLaunch} />);
    fireEvent.click(screen.getByText("GIMP"));
    expect(onLaunch).toHaveBeenCalledWith(apps[0]);
  });

  it("shows why a launch failed", () => {
    // Launching produces a window, which becomes a tab elsewhere; a launch
    // that fails produces nothing at all. Without this the click and a broken
    // host look identical, which is exactly how it was reported.
    render(
      <AppLauncherPanel
        apps={apps}
        onLaunch={vi.fn()}
        notice={{ kind: "error", message: "libgtk-3.so.0: cannot open shared object file" }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("libgtk-3.so.0");
  });

  it("says an application is starting while it has nothing else to show", () => {
    render(
      <AppLauncherPanel
        apps={apps}
        onLaunch={vi.fn()}
        notice={{ kind: "pending", message: "Starting GIMP…" }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Starting GIMP…");
  });

  it("refuses an entry that needs a terminal it cannot provide", () => {
    const onLaunch = vi.fn();
    render(<AppLauncherPanel apps={apps} onLaunch={onLaunch} />);
    fireEvent.click(screen.getByText("Vim"));
    expect(onLaunch).not.toHaveBeenCalled();
  });
});
