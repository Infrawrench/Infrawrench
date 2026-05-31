import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ImportYamlModal } from "../../components/ImportYamlModal.js";

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

describe("ImportYamlModal", () => {
  it("renders a custom title", () => {
    render(<ImportYamlModal title="Import manifest" onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Import manifest" })).toBeInTheDocument();
  });

  it("defaults the title to Import YAML", () => {
    render(<ImportYamlModal onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Import YAML" })).toBeInTheDocument();
  });

  it("disables Apply while the textarea is empty", () => {
    render(<ImportYamlModal onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("applies YAML and shows the applied count", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ applied: 2 });
    const onApplied = vi.fn();
    render(<ImportYamlModal onClose={vi.fn()} onSubmit={onSubmit} onApplied={onApplied} />);
    fireEvent.change(screen.getByLabelText("YAML content"), {
      target: { value: "kind: ConfigMap" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("Applied 2 documents.")).toBeInTheDocument();
    expect(onApplied).toHaveBeenCalledOnce();
    // The footer action relabels from "Cancel" to "Close" after a successful apply.
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("uses singular wording for one document", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ applied: 1 });
    render(<ImportYamlModal onClose={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("YAML content"), { target: { value: "kind: X" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("Applied 1 document.")).toBeInTheDocument();
  });

  it("surfaces a submit error", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("bad yaml"));
    render(<ImportYamlModal onClose={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("YAML content"), { target: { value: "kind: X" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("bad yaml")).toBeInTheDocument();
  });

  it("calls onClose from the cancel button", () => {
    const onClose = vi.fn();
    render(<ImportYamlModal onClose={onClose} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("loads YAML from a picked file", async () => {
    render(<ImportYamlModal onClose={vi.fn()} onSubmit={vi.fn()} />);
    const file = new File(["kind: FromFile"], "manifest.yaml", { type: "text/yaml" });
    const input = screen.getByLabelText("Load YAML file") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect((screen.getByLabelText("YAML content") as HTMLTextAreaElement).value).toBe(
        "kind: FromFile",
      ),
    );
  });
});
