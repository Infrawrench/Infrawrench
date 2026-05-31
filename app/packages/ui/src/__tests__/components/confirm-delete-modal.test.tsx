import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConfirmDeleteModal } from "../../components/ConfirmDeleteModal.js";

beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
  }
});

describe("ConfirmDeleteModal", () => {
  it("renders the kind in heading and button", () => {
    render(
      <ConfirmDeleteModal kind="server" name="my-server" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("heading", { name: "Delete server" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete server" })).toBeInTheDocument();
  });

  it("disables the delete button until the name matches", () => {
    render(<ConfirmDeleteModal kind="db" name="prod-db" onConfirm={vi.fn()} onClose={vi.fn()} />);
    const deleteBtn = screen.getByRole("button", { name: "Delete db" });
    expect(deleteBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Type prod-db to confirm"), {
      target: { value: "prod-db" },
    });
    expect(deleteBtn).toBeEnabled();
  });

  it("calls onConfirm when the matching name is typed and delete clicked", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<ConfirmDeleteModal kind="bucket" name="b1" onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Type b1 to confirm"), {
      target: { value: "b1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete bucket" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
  });

  it("confirms on Enter when matching", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<ConfirmDeleteModal kind="vol" name="v1" onConfirm={onConfirm} onClose={vi.fn()} />);
    const input = screen.getByLabelText("Type v1 to confirm");
    fireEvent.change(input, { target: { value: "v1" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
  });

  it("does not confirm on Enter when the name does not match", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDeleteModal kind="vol" name="v1" onConfirm={onConfirm} onClose={vi.fn()} />);
    const input = screen.getByLabelText("Type v1 to confirm");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("surfaces an error message when onConfirm rejects", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error("boom"));
    render(<ConfirmDeleteModal kind="x" name="n" onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Type n to confirm"), { target: { value: "n" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete x" }));
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    render(<ConfirmDeleteModal kind="x" name="n" onConfirm={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
