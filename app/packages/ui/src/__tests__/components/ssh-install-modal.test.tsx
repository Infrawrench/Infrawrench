import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SshInstallModal } from "../../components/detail/SshInstallModal.js";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
const account = {
  accountId: "tailnet",
  displayName: "Work",
  pluginId: "tailscale",
  serviceName: "Tailscale",
  description: "Install on Linux with sudo.",
};
function show(overrides: Partial<Parameters<typeof SshInstallModal>[0]> = {}) {
  const props = {
    hostName: "server-1",
    accounts: [account],
    loading: false,
    ready: true,
    onRun: vi.fn().mockResolvedValue({ message: "Connected", address: "100.64.0.1" }),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<SshInstallModal {...props} />);
  return props;
}
describe("SSH service installer", () => {
  it("requires an account and explains how to add one", () => {
    show({ accounts: [] });
    expect(screen.getByText(/can install a service over SSH yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Tailscale/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install and connect" })).toBeDisabled();
  });
  it("waits for SSH credentials before allowing installation", () => {
    show({ ready: false });
    expect(screen.getByRole("button", { name: "Install and connect" })).toBeDisabled();
  });
  it("submits the selected account and shows the resulting network address", async () => {
    const props = show();
    fireEvent.click(screen.getByRole("button", { name: "Install and connect" }));
    await screen.findByText("Connected");
    expect(props.onRun).toHaveBeenCalledWith("tailnet");
    expect(screen.getByText("Network address: 100.64.0.1")).toBeInTheDocument();
  });
  it("prevents duplicate installs and dismissal while a run is pending", async () => {
    let finish!: (value: { message: string }) => void;
    const props = show({
      onRun: vi.fn().mockImplementation(
        () =>
          new Promise((r) => {
            finish = r;
          }),
      ),
    });
    fireEvent.click(screen.getByRole("button", { name: "Install and connect" }));
    expect(screen.getByRole("button", { name: "Installing…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(props.onClose).not.toHaveBeenCalled();
    finish({ message: "Done" });
    await screen.findByText("Done");
  });
  it("keeps the form available after failure so the user can retry", async () => {
    show({ onRun: vi.fn().mockRejectedValue(new Error("SSH authentication failed")) });
    fireEvent.click(screen.getByRole("button", { name: "Install and connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("SSH authentication failed");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Install and connect" })).toBeEnabled(),
    );
  });
});
