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

  /**
   * Chromium dispatches `click` at the nearest common ancestor of its
   * pointerdown and pointerup targets. For anything inside this dialog that
   * ancestor is the `<dialog>` itself, so a drag that leaves the panel is
   * indistinguishable from a backdrop click by target alone — and dismissing
   * on it throws away whatever the user had just typed. These pin the
   * pointer-origin guard that stops it.
   */
  describe("drag out of the panel", () => {
    it("does not close when the pointer goes down inside and up on the backdrop", () => {
      const onClose = vi.fn();
      render(
        <Modal onClose={onClose}>
          <input aria-label="name" defaultValue="typed so far" />
        </Modal>,
      );
      const dialog = document.querySelector("dialog")!;
      fireEvent.pointerDown(screen.getByLabelText("name"));
      fireEvent.pointerUp(dialog);
      // The click Chromium then synthesises, targeted at the common ancestor.
      fireEvent.click(dialog);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("does not close when the pointer goes down on the backdrop and up inside", () => {
      const onClose = vi.fn();
      render(
        <Modal onClose={onClose}>
          <input aria-label="name" defaultValue="typed so far" />
        </Modal>,
      );
      const dialog = document.querySelector("dialog")!;
      fireEvent.pointerDown(dialog);
      fireEvent.pointerUp(screen.getByLabelText("name"));
      fireEvent.click(dialog);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("still closes when both ends of the interaction are on the backdrop", () => {
      const onClose = vi.fn();
      render(
        <Modal onClose={onClose}>
          <input aria-label="name" />
        </Modal>,
      );
      const dialog = document.querySelector("dialog")!;
      fireEvent.pointerDown(dialog);
      fireEvent.pointerUp(dialog);
      fireEvent.click(dialog);
      expect(onClose).toHaveBeenCalledOnce();
    });

    it("does not let an abandoned interaction suppress the next backdrop click", () => {
      const onClose = vi.fn();
      render(
        <Modal onClose={onClose}>
          <input aria-label="name" />
        </Modal>,
      );
      const dialog = document.querySelector("dialog")!;
      // A touch that turned into a scroll: pointerdown inside, then cancelled,
      // so no click ever arrives for it.
      fireEvent.pointerDown(screen.getByLabelText("name"));
      fireEvent.pointerCancel(dialog);
      // The next interaction is a genuine backdrop click and must still close.
      fireEvent.pointerDown(dialog);
      fireEvent.pointerUp(dialog);
      fireEvent.click(dialog);
      expect(onClose).toHaveBeenCalledOnce();
    });

    it("re-arms after a suppressed drag so the following backdrop click closes", () => {
      const onClose = vi.fn();
      render(
        <Modal onClose={onClose}>
          <input aria-label="name" />
        </Modal>,
      );
      const dialog = document.querySelector("dialog")!;
      fireEvent.pointerDown(screen.getByLabelText("name"));
      fireEvent.pointerUp(dialog);
      fireEvent.click(dialog);
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.pointerDown(dialog);
      fireEvent.pointerUp(dialog);
      fireEvent.click(dialog);
      expect(onClose).toHaveBeenCalledOnce();
    });
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

  it("exposes the accessible name it was given", () => {
    render(
      <Modal onClose={() => {}} ariaLabel="Budget">
        <p>x</p>
      </Modal>,
    );
    expect(document.querySelector("dialog")).toHaveAttribute("aria-label", "Budget");
  });

  // Without onClose the dialog is still a real modal — focus trapped, page
  // behind it inert — it just can't be dismissed from outside its own controls.
  describe("without onClose", () => {
    it("ignores a backdrop click", () => {
      render(
        <Modal>
          <p>content</p>
        </Modal>,
      );
      const dialog = document.querySelector("dialog")!;
      fireEvent.click(dialog);
      expect(dialog.open).toBe(true);
    });

    it("ignores a full pointer interaction on the backdrop", () => {
      render(
        <Modal>
          <p>content</p>
        </Modal>,
      );
      const dialog = document.querySelector("dialog")!;
      fireEvent.pointerDown(dialog);
      fireEvent.pointerUp(dialog);
      fireEvent.click(dialog);
      expect(dialog.open).toBe(true);
    });

    it("swallows Escape rather than letting the browser close the element", () => {
      render(
        <Modal>
          <p>x</p>
        </Modal>,
      );
      const dialog = document.querySelector("dialog")!;
      const cancel = new Event("cancel", { cancelable: true });
      fireEvent(dialog, cancel);
      expect(cancel.defaultPrevented).toBe(true);
      expect(dialog.open).toBe(true);
    });
  });

  it("marks a fullScreen modal so it fills the viewport", () => {
    render(
      <Modal fullScreen>
        <p>x</p>
      </Modal>,
    );
    expect(document.querySelector("dialog")!.className).toContain("infrawrench-modal--full");
  });
});
