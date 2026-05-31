import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OrgSwitcher, type OrgEntry } from "../../components/OrgSwitcher.js";

const orgs: OrgEntry[] = [
  { id: "o1", displayName: "Acme", role: "owner" },
  { id: "o2", displayName: "Beta Co", role: "member" },
];

describe("OrgSwitcher", () => {
  it("shows the active org's display name as the label", () => {
    render(<OrgSwitcher orgs={orgs} activeOrgId="o1" onSwitch={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Acme/ })).toBeInTheDocument();
  });

  it("shows a loading label when no active org and loading", () => {
    render(<OrgSwitcher orgs={[]} activeOrgId={null} onSwitch={vi.fn()} loading />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows Select organization when nothing is active and not loading", () => {
    render(<OrgSwitcher orgs={[]} activeOrgId={null} onSwitch={vi.fn()} />);
    expect(screen.getByText("Select organization")).toBeInTheDocument();
  });

  it("opens the dropdown and switches org", () => {
    const onSwitch = vi.fn();
    render(<OrgSwitcher orgs={orgs} activeOrgId="o1" onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button", { name: /Acme/ }));
    fireEvent.click(screen.getByRole("button", { name: /Beta Co/ }));
    expect(onSwitch).toHaveBeenCalledWith("o2");
  });

  it("offers a Local option and switches to local mode", () => {
    const onSwitch = vi.fn();
    render(<OrgSwitcher orgs={orgs} activeOrgId="o1" onSwitch={onSwitch} showLocalOption />);
    fireEvent.click(screen.getByRole("button", { name: /Acme/ }));
    fireEvent.click(screen.getByRole("button", { name: "Local" }));
    expect(onSwitch).toHaveBeenCalledWith(null);
  });

  it("renders Local as the label when local mode is active", () => {
    render(<OrgSwitcher orgs={orgs} activeOrgId={null} onSwitch={vi.fn()} showLocalOption />);
    expect(screen.getByRole("button", { name: /Local/ })).toBeInTheDocument();
  });

  it("invokes onCreateOrg from the dropdown footer", () => {
    const onCreateOrg = vi.fn();
    render(
      <OrgSwitcher orgs={orgs} activeOrgId="o1" onSwitch={vi.fn()} onCreateOrg={onCreateOrg} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Acme/ }));
    fireEvent.click(screen.getByRole("button", { name: "+ Create organization" }));
    expect(onCreateOrg).toHaveBeenCalledOnce();
  });

  it("closes when clicking outside", () => {
    render(<OrgSwitcher orgs={orgs} activeOrgId="o1" onSwitch={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Acme/ }));
    expect(screen.getByRole("button", { name: /Beta Co/ })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("button", { name: /Beta Co/ })).not.toBeInTheDocument();
  });
});
