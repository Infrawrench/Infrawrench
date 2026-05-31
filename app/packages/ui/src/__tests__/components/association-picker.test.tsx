import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AssociationPicker } from "../../components/detail/AssociationPicker.js";
import type { ProviderResource } from "../../components/detail/detail-types.js";

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

const providerResources: ProviderResource[] = [
  {
    resourceId: "db-1",
    pluginId: "do",
    resourceTypeId: "database",
    accountId: "a1",
    displayName: "prod-db",
    outputKey: "connectionUri",
    pluginLogoSvg: "<svg></svg>",
  },
];

describe("AssociationPicker", () => {
  it("renders the field key and both mode tabs", () => {
    render(
      <AssociationPicker
        fieldKey="DATABASE_URL"
        providerResources={providerResources}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("DATABASE_URL")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "From resource" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Paste literal value" })).toBeInTheDocument();
  });

  it("disables Confirm until a provider resource is picked, then emits an output-ref", () => {
    const onConfirm = vi.fn();
    render(
      <AssociationPicker
        fieldKey="DATABASE_URL"
        providerResources={providerResources}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
    fireEvent.click(screen.getByText("prod-db"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith({
      kind: "output-ref",
      providerResourceId: "db-1",
      providerPluginId: "do",
      providerResourceTypeId: "database",
      providerAccountId: "a1",
      providerOutputKey: "connectionUri",
    });
  });

  it("switches to literal mode and confirms a pasted value", () => {
    const onConfirm = vi.fn();
    render(
      <AssociationPicker
        fieldKey="TOKEN"
        providerResources={providerResources}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Paste literal value" }));
    fireEvent.change(screen.getByLabelText("TOKEN value"), { target: { value: "secret-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith({ kind: "literal", value: "secret-123" });
  });

  it("shows an empty state when no provider resources exist", () => {
    render(
      <AssociationPicker
        fieldKey="X"
        providerResources={[]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("No compatible resources found.")).toBeInTheDocument();
  });

  it("navigates tabs with the keyboard", () => {
    render(
      <AssociationPicker
        fieldKey="X"
        providerResources={providerResources}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: "From resource" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Paste literal value" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("cancels via Cancel button", () => {
    const onCancel = vi.fn();
    render(
      <AssociationPicker
        fieldKey="X"
        providerResources={providerResources}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
