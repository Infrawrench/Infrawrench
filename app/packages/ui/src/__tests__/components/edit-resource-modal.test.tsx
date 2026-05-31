import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EditResourceModal } from "../../components/EditResourceModal.js";
import type { FieldDefinition } from "@infrawrench/plugin-base";

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

const fields: FieldDefinition[] = [
  { key: "name", label: "Name", kind: "string", required: true },
  { key: "count", label: "Count", kind: "number" },
  { key: "enabled", label: "Enabled", kind: "boolean" },
  { key: "tier", label: "Tier", kind: "enum", enumValues: ["a", "b"] },
  { key: "secretKey", label: "Secret", kind: "secret" },
  { key: "ref", label: "Ref", kind: "association" },
  { key: "locked", label: "Locked", kind: "string", editable: false },
] as FieldDefinition[];

describe("EditResourceModal", () => {
  it("renders only editable, non-secret, non-association fields", () => {
    render(
      <EditResourceModal
        displayName="Project"
        fields={fields}
        initialValues={{ name: "p1", count: "2", enabled: "true", tier: "a" }}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Edit Project" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Count" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Enabled" })).toBeInTheDocument();
    // The enum control renders a <select> (no aria-label wiring in the component).
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getByText("Tier")).toBeInTheDocument();
    expect(screen.queryByLabelText("Secret")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Ref")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Locked")).not.toBeInTheDocument();
  });

  it("disables Save until something changes", () => {
    render(
      <EditResourceModal
        displayName="X"
        fields={fields}
        initialValues={{ name: "p1" }}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "p2" } });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("submits only the changed fields", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <EditResourceModal
        displayName="X"
        fields={fields}
        initialValues={{ name: "p1", count: "2" }}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );
    fireEvent.change(screen.getByRole("spinbutton", { name: "Count" }), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ count: "5" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps Save disabled when a required field is blanked", () => {
    render(
      <EditResourceModal
        displayName="X"
        fields={fields}
        initialValues={{ name: "p1" }}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "  " } });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("surfaces a submit error and stays open", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("save failed"));
    const onClose = vi.fn();
    render(
      <EditResourceModal
        displayName="X"
        fields={fields}
        initialValues={{ name: "p1" }}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "p2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("save failed")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows a message when there are no editable fields", () => {
    render(
      <EditResourceModal
        displayName="X"
        fields={[{ key: "s", label: "S", kind: "secret" } as FieldDefinition]}
        initialValues={{}}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("This resource has no editable fields.")).toBeInTheDocument();
  });

  it("closes via Cancel", () => {
    const onClose = vi.fn();
    render(
      <EditResourceModal
        displayName="X"
        fields={fields}
        initialValues={{ name: "p1" }}
        onSubmit={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
