import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MultiSelect, type MultiSelectOption } from "../../components/MultiSelect.js";

const options: MultiSelectOption[] = [
  { value: "cr-basic", label: "Container Registry (basic)" },
  { value: "cr-storage", label: "Container Registry Storage Overage" },
  { value: "inference", label: "Inference Cloud Trial" },
  { value: "spaces", label: "Spaces ($5/mo 250GiB storage & 1TiB transfer)" },
  { value: "vat-uk", label: "VAT United Kingdom (20.00%)" },
];

function open(label = "Services") {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

describe("MultiSelect", () => {
  it("filters options as you type", () => {
    render(<MultiSelect options={options} value={[]} onChange={() => {}} label="Services" />);
    open();
    expect(screen.getAllByRole("option")).toHaveLength(5);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "registry" } });
    const shown = screen.getAllByRole("option").map((o) => o.textContent);
    expect(shown).toHaveLength(2);
    expect(shown[0]).toContain("Container Registry (basic)");
  });

  it("matches case-insensitively and reports when nothing matches", () => {
    render(<MultiSelect options={options} value={[]} onChange={() => {}} label="Services" />);
    open();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "VAT" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "kubernetes" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/No matches for/)).toBeTruthy();
  });

  it("toggles a value on click without dropping existing selections", () => {
    const onChange = vi.fn();
    render(
      <MultiSelect options={options} value={["inference"]} onChange={onChange} label="Services" />,
    );
    open();
    fireEvent.click(screen.getByRole("option", { name: /Container Registry \(basic\)/ }));
    expect(onChange).toHaveBeenCalledWith(["inference", "cr-basic"]);
  });

  it("deselects an already-selected value", () => {
    const onChange = vi.fn();
    render(
      <MultiSelect options={options} value={["inference"]} onChange={onChange} label="Services" />,
    );
    open();
    fireEvent.click(screen.getByRole("option", { name: /Inference Cloud Trial/ }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("shows selections as chips and removes one without opening the panel", () => {
    const onChange = vi.fn();
    render(
      <MultiSelect
        options={options}
        value={["inference", "vat-uk"]}
        onChange={onChange}
        label="Services"
      />,
    );
    expect(screen.getByText("Inference Cloud Trial")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove VAT United Kingdom (20.00%)" }));
    expect(onChange).toHaveBeenCalledWith(["inference"]);
    // The chip's click must not have toggled the panel open.
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("summarizes past four selections rather than growing without bound", () => {
    render(
      <MultiSelect
        options={options}
        value={options.map((o) => o.value)}
        onChange={() => {}}
        label="Services"
      />,
    );
    expect(screen.getByText("+1 more")).toBeTruthy();
  });

  it("keeps a selected value selectable when the load didn't return it", () => {
    render(
      <MultiSelect options={[]} value={["retired-service"]} onChange={() => {}} label="Services" />,
    );
    // Falls back to the raw value for its label rather than rendering blank.
    expect(screen.getByText("retired-service")).toBeTruthy();
  });

  it("navigates with the arrow keys and toggles with Enter", () => {
    const onChange = vi.fn();
    render(<MultiSelect options={options} value={[]} onChange={onChange} label="Services" />);
    open();
    const search = screen.getByRole("combobox");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["cr-storage"]);
  });

  it("removes the last chip on Backspace with an empty query", () => {
    const onChange = vi.fn();
    render(
      <MultiSelect
        options={options}
        value={["inference", "vat-uk"]}
        onChange={onChange}
        label="Services"
      />,
    );
    open();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Backspace" });
    expect(onChange).toHaveBeenCalledWith(["inference"]);
  });

  it("closes on Escape", () => {
    render(<MultiSelect options={options} value={[]} onChange={() => {}} label="Services" />);
    open();
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("clears every selection from the panel", () => {
    const onChange = vi.fn();
    render(
      <MultiSelect
        options={options}
        value={["inference", "vat-uk"]}
        onChange={onChange}
        label="Services"
      />,
    );
    open();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("offers a retry when the values failed to load", () => {
    const onRetry = vi.fn();
    render(
      <MultiSelect
        options={[]}
        value={[]}
        onChange={() => {}}
        label="Services"
        status={{ kind: "error", message: "Couldn’t load values.", onRetry }}
      />,
    );
    open();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("distinguishes loading from empty", () => {
    const { rerender } = render(
      <MultiSelect
        options={[]}
        value={[]}
        onChange={() => {}}
        label="Services"
        status={{ kind: "loading" }}
      />,
    );
    open();
    expect(screen.getByText("Loading values…")).toBeTruthy();

    rerender(
      <MultiSelect
        options={[]}
        value={[]}
        onChange={() => {}}
        label="Services"
        status={{ kind: "empty", message: "No values in cost data yet" }}
      />,
    );
    expect(screen.getByText("No values in cost data yet")).toBeTruthy();
  });
});
