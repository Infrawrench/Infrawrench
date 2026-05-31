import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Modal } from "../../components/Modal.js";

beforeAll(() => {
  // jsdom doesn't implement <dialog> showModal/close — stub them.
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

describe("Modal", () => {
  it("renders its children", () => {
    render(
      <Modal onClose={() => {}}>
        <p>Modal body</p>
      </Modal>,
    );
    expect(screen.getByText("Modal body")).toBeInTheDocument();
  });

  it("calls onClose when the backdrop (dialog itself) is clicked", () => {
    const onClose = vi.fn();
    render(
      <Modal onClose={onClose}>
        <p>content</p>
      </Modal>,
    );
    const dialog = document.querySelector("dialog")!;
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not call onClose when inner content is clicked", () => {
    const onClose = vi.fn();
    render(
      <Modal onClose={onClose}>
        <button type="button">inner</button>
      </Modal>,
    );
    fireEvent.click(screen.getByText("inner"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose on the dialog cancel (Escape) event", () => {
    const onClose = vi.fn();
    render(
      <Modal onClose={onClose}>
        <p>x</p>
      </Modal>,
    );
    const dialog = document.querySelector("dialog")!;
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("applies a custom className", () => {
    render(
      <Modal onClose={() => {}} className="my-class">
        <p>x</p>
      </Modal>,
    );
    expect(document.querySelector("dialog")!.className).toContain("my-class");
  });
});
