import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SidebarItem } from "../../components/sidebar/SidebarItem.js";
import { SidebarSection } from "../../components/sidebar/SidebarSection.js";
import { useUIStore } from "../../store/ui.store.js";
import type { SidebarItemSchema } from "@infrawrench/plugin-base";

const LOGO = '<svg data-testid="logo"></svg>';

beforeEach(() => {
  useUIStore.setState({ selectedResource: null });
});

describe("SidebarItem", () => {
  it("renders the label and selects the resource on click", () => {
    const item: SidebarItemSchema = { id: "r1", label: "Resource 1" };
    render(<SidebarItem item={item} pluginId="do" resourceTypeId="droplet" />);
    fireEvent.click(screen.getByRole("button", { name: "Resource 1" }));
    expect(useUIStore.getState().selectedResource).toEqual({
      pluginId: "do",
      resourceTypeId: "droplet",
      resourceId: "r1",
    });
  });

  it("expands and collapses children", () => {
    const item: SidebarItemSchema = {
      id: "parent",
      label: "Parent",
      children: [{ id: "child", label: "Child" }],
    };
    render(<SidebarItem item={item} pluginId="do" resourceTypeId="droplet" />);
    expect(screen.queryByText("Child")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Parent/ }));
    expect(screen.getByText("Child")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Parent/ }));
    expect(screen.queryByText("Child")).not.toBeInTheDocument();
  });

  it("highlights the selected item", () => {
    useUIStore.setState({
      selectedResource: { pluginId: "do", resourceTypeId: "droplet", resourceId: "sel" },
    });
    const item: SidebarItemSchema = { id: "sel", label: "Selected" };
    render(<SidebarItem item={item} pluginId="do" resourceTypeId="droplet" />);
    expect(screen.getByRole("button", { name: "Selected" }).className).toContain(
      "bg-surface-overlay",
    );
  });

  it("renders a status dot when provided", () => {
    const item: SidebarItemSchema = {
      id: "r",
      label: "WithStatus",
      status: { kind: "status-dot", status: "error", label: "Down" },
    };
    render(<SidebarItem item={item} pluginId="do" resourceTypeId="droplet" />);
    expect(screen.getByText("Down")).toBeInTheDocument();
  });
});

describe("SidebarSection", () => {
  const baseProps = {
    pluginName: "DigitalOcean",
    pluginLogoSvg: LOGO,
    pluginId: "do",
    accountName: "acct-1",
    accountId: "a1",
    resourceGroups: [
      {
        resourceTypeId: "droplet",
        displayName: "Droplets",
        items: [{ id: "d1", label: "droplet-1" }],
      },
    ],
  };

  it("renders plugin + account header and resource group", () => {
    render(<SidebarSection {...baseProps} />);
    expect(screen.getByText(/DigitalOcean · acct-1/)).toBeInTheDocument();
    expect(screen.getByText("Droplets")).toBeInTheDocument();
    expect(screen.getByText("droplet-1")).toBeInTheDocument();
  });

  it("collapses the section when the header is clicked", () => {
    render(<SidebarSection {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /DigitalOcean · acct-1/ }));
    expect(screen.queryByText("Droplets")).not.toBeInTheDocument();
  });

  it("collapses an individual resource-type group", () => {
    render(<SidebarSection {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /Droplets/ }));
    expect(screen.queryByText("droplet-1")).not.toBeInTheDocument();
  });

  it("shows a No resources message for an empty group", () => {
    render(
      <SidebarSection
        {...baseProps}
        resourceGroups={[{ resourceTypeId: "vol", displayName: "Volumes", items: [] }]}
      />,
    );
    expect(screen.getByText("No resources")).toBeInTheDocument();
  });
});
