import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { SectionTabs } from "../../components/SectionTabs.js";

function Probe({ name, onMount }: { name: string; onMount: (name: string) => void }) {
  useEffect(() => onMount(name), [name, onMount]);
  return <p>{name} body</p>;
}

function tabs(onMount: (name: string) => void) {
  return [
    { id: "a", label: "Alpha", content: <Probe name="alpha" onMount={onMount} /> },
    { id: "b", label: "Beta", content: <Probe name="beta" onMount={onMount} /> },
    { id: "c", label: "Gamma", content: <Probe name="gamma" onMount={onMount} /> },
  ];
}

afterEach(() => localStorage.clear());

describe("SectionTabs", () => {
  it("mounts a panel on first open and keeps it mounted after", () => {
    const onMount = vi.fn();
    render(<SectionTabs ariaLabel="Views" tabs={tabs(onMount)} />);
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("beta body")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Beta" }));
    expect(screen.getByText("beta body")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Alpha" }));
    expect(screen.getByText("beta body")).not.toBeVisible();
    expect(onMount).toHaveBeenCalledTimes(2);
  });

  it("remembers the last tab under the storage key", () => {
    const { unmount } = render(
      <SectionTabs ariaLabel="Views" storageKey="k" tabs={tabs(() => {})} />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Gamma" }));
    unmount();
    render(<SectionTabs ariaLabel="Views" storageKey="k" tabs={tabs(() => {})} />);
    expect(screen.getByRole("tab", { name: "Gamma" })).toHaveAttribute("aria-selected", "true");
  });

  it("prefers initialTab over the remembered one", () => {
    localStorage.setItem("k", "c");
    render(<SectionTabs ariaLabel="Views" storageKey="k" initialTab="b" tabs={tabs(() => {})} />);
    expect(screen.getByRole("tab", { name: "Beta" })).toHaveAttribute("aria-selected", "true");
  });

  it("moves between tabs with the arrow keys", () => {
    render(<SectionTabs ariaLabel="Views" tabs={tabs(() => {})} />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Alpha" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Gamma" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("gamma body");
  });
});
