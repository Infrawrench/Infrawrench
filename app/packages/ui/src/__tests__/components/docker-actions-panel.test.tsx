import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DockerActionsPanel } from "../../components/DockerActionsPanel.js";

describe("DockerActionsPanel", () => {
  it("renders the three container actions", () => {
    render(<DockerActionsPanel containerId="c1" onCommand={vi.fn().mockResolvedValue({})} />);
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart" })).toBeInTheDocument();
  });

  it("runs the start command with the container id and shows success", async () => {
    const onCommand = vi.fn().mockResolvedValue({});
    render(<DockerActionsPanel containerId="c1" onCommand={onCommand} />);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onCommand).toHaveBeenCalledWith("startContainer", { id: "c1" });
    expect(await screen.findByText("Start succeeded")).toBeInTheDocument();
  });

  it("shows an error message when a command fails", async () => {
    const onCommand = vi.fn().mockRejectedValue(new Error("daemon down"));
    render(<DockerActionsPanel containerId="c1" onCommand={onCommand} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText(/daemon down/)).toBeInTheDocument();
  });

  it("disables buttons while a command is running", async () => {
    let resolve: (v: unknown) => void = () => {};
    const onCommand = vi.fn(() => new Promise((r) => (resolve = r)));
    render(<DockerActionsPanel containerId="c1" onCommand={onCommand} />);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(screen.getByText("Restart…")).toBeInTheDocument();
    resolve({});
    await waitFor(() => expect(screen.getByRole("button", { name: "Start" })).toBeEnabled());
  });
});
