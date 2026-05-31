import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SshKeyRadioGroup, SshKeyRadioItem } from "../../components/SshKeyRadioGroup.js";

describe("SshKeyRadioGroup", () => {
  const keys = [
    { id: "k1", label: "key-one", sublabel: "SHA256:" },
    { id: "k2", label: "key-two", meta: "ed25519" },
  ];

  it("renders all options with the aria legend", () => {
    render(
      <SshKeyRadioGroup keys={keys} selectedId="k1" onChange={vi.fn()} ariaLabel="SSH keys" />,
    );
    expect(screen.getByText("SSH keys")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "key-one" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "key-two" })).not.toBeChecked();
  });

  it("calls onChange with id and option when an item is picked", () => {
    const onChange = vi.fn();
    render(<SshKeyRadioGroup keys={keys} selectedId="k1" onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "key-two" }));
    expect(onChange).toHaveBeenCalledWith("k2", keys[1]);
  });

  it("renders meta content", () => {
    render(<SshKeyRadioGroup keys={keys} selectedId={null} onChange={vi.fn()} />);
    expect(screen.getByText("ed25519")).toBeInTheDocument();
  });
});

describe("SshKeyRadioItem", () => {
  it("fires onSelect and renders trailing content", () => {
    const onSelect = vi.fn();
    render(
      <SshKeyRadioItem
        name="grp"
        value="v"
        label="lbl"
        selected={false}
        onSelect={onSelect}
        trailing={<span>trail</span>}
      />,
    );
    expect(screen.getByText("trail")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "lbl" }));
    expect(onSelect).toHaveBeenCalledOnce();
  });
});
