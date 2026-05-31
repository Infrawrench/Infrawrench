import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { PolicyPicker } from "../../components/create-resource/PolicyPicker.js";
import type { PolicyOption } from "@infrawrench/plugin-base";

const policies: PolicyOption[] = [
  { id: "p.read", label: "Read", category: "Storage", description: "Read objects" },
  { id: "p.write", label: "Write", category: "Storage", badge: "beta" },
  { id: "p.admin", label: "Admin", category: "Admin", badge: "deprecated" },
] as PolicyOption[];

describe("PolicyPicker", () => {
  it("renders categories with policy rows", () => {
    render(<PolicyPicker policies={policies} value="" onChange={vi.fn()} />);
    expect(screen.getByText("Storage")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Read" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Admin" })).toBeInTheDocument();
  });

  it("toggles a policy on and emits the serialized selection", () => {
    const onChange = vi.fn();
    render(<PolicyPicker policies={policies} value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Read" }));
    expect(onChange).toHaveBeenCalledWith(JSON.stringify(["p.read"]));
  });

  it("toggles a policy off when already selected", () => {
    const onChange = vi.fn();
    render(
      <PolicyPicker policies={policies} value={JSON.stringify(["p.read"])} onChange={onChange} />,
    );
    const listRow = screen.getByRole("checkbox", { name: "Read" });
    fireEvent.click(listRow);
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("renders selected chips and removes via chip button", () => {
    const onChange = vi.fn();
    render(
      <PolicyPicker
        policies={policies}
        value={JSON.stringify(["p.read", "p.write"])}
        onChange={onChange}
      />,
    );
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Read" }));
    expect(onChange).toHaveBeenCalledWith(JSON.stringify(["p.write"]));
  });

  it("filters the policy list by search", () => {
    render(<PolicyPicker policies={policies} value="" onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search policies"), { target: { value: "admin" } });
    expect(screen.getByRole("checkbox", { name: "Admin" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Read" })).not.toBeInTheDocument();
  });

  it("shows No matches when search excludes everything", () => {
    render(<PolicyPicker policies={policies} value="" onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search policies"), { target: { value: "zzz" } });
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("renders badge chips for alpha/beta/deprecated policies", () => {
    render(<PolicyPicker policies={policies} value="" onChange={vi.fn()} />);
    expect(screen.getByText("BETA")).toBeInTheDocument();
    expect(screen.getByText("DEPRECATED")).toBeInTheDocument();
  });

  it("falls back to the id when a selected policy isn't in the list", () => {
    render(
      <PolicyPicker
        policies={policies}
        value={JSON.stringify(["ghost.policy"])}
        onChange={vi.fn()}
      />,
    );
    const chips = screen.getByText("1 selected").closest("div")!.parentElement!;
    expect(within(chips).getByText("ghost.policy")).toBeInTheDocument();
  });
});
