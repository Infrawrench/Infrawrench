import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DashboardCard } from "../../components/dashboard/DashboardCard.js";
import { DashboardGrid } from "../../components/dashboard/DashboardGrid.js";
import { useUIStore } from "../../store/ui.store.js";
import type { DashboardCardSchema } from "@infrawrench/plugin-base";

const LOGO = '<svg data-testid="logo"></svg>';

function makeCard(partial: Partial<DashboardCardSchema> = {}): DashboardCardSchema {
  return {
    pluginId: "do",
    resourceTypeId: "droplet",
    resourceId: "d-1",
    displayName: "web-1",
    ...partial,
  } as DashboardCardSchema;
}

beforeEach(() => {
  useUIStore.setState({ selectedResource: null });
});

describe("DashboardCard", () => {
  it("renders the display name and logo", () => {
    render(<DashboardCard card={makeCard()} pluginLogoSvg={LOGO} />);
    expect(screen.getByText("web-1")).toBeInTheDocument();
    expect(document.querySelector('[data-testid="logo"]')).toBeTruthy();
  });

  it("renders badges and status", () => {
    render(
      <DashboardCard
        card={makeCard({
          badges: [{ kind: "badge", label: "prod", color: "blue" }],
          status: { kind: "status-dot", status: "healthy", label: "Up" },
        })}
        pluginLogoSvg={LOGO}
      />,
    );
    expect(screen.getByText("prod")).toBeInTheDocument();
    expect(screen.getByText("Up")).toBeInTheDocument();
  });

  it("selects the resource in the store on click", () => {
    render(<DashboardCard card={makeCard()} pluginLogoSvg={LOGO} />);
    fireEvent.click(screen.getByRole("button"));
    expect(useUIStore.getState().selectedResource).toEqual({
      pluginId: "do",
      resourceTypeId: "droplet",
      resourceId: "d-1",
    });
  });
});

describe("DashboardGrid", () => {
  it("shows the empty message when there are no cards", () => {
    render(<DashboardGrid cards={[]} emptyMessage="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });

  it("renders the default empty message", () => {
    render(<DashboardGrid cards={[]} />);
    expect(screen.getByText("Pin resources to see them here.")).toBeInTheDocument();
  });

  it("renders one card per entry", () => {
    render(
      <DashboardGrid
        cards={[
          { card: makeCard({ resourceId: "a", displayName: "A" }), pluginLogoSvg: LOGO },
          { card: makeCard({ resourceId: "b", displayName: "B" }), pluginLogoSvg: LOGO },
        ]}
      />,
    );
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
  });
});
