import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NewMigrationEstimateModal } from "../migration-estimates/NewMigrationEstimateModal.js";
import type { MigrationEstimatesClient } from "../migration-estimates/types.js";

function client(services: Array<{ id: string; name: string }>): MigrationEstimatesClient {
  return {
    targets: () => Promise.resolve([]),
    list: () => Promise.resolve([]),
    get: () => Promise.reject(new Error("unused")),
    result: () => Promise.reject(new Error("unused")),
    terraform: () => Promise.reject(new Error("unused")),
    listServices: () => Promise.resolve(services),
    create: () => Promise.reject(new Error("unused")),
  };
}

beforeAll(() => {
  // jsdom doesn't implement <dialog> showModal/close, and Modal is a <dialog>.
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

describe("NewMigrationEstimateModal", () => {
  it("sends an org with no services to where a source can be made", async () => {
    // The form used to show an empty service picker and a disabled Estimate
    // button with a one-line hint, which read as a dead end.
    const onOpenServices = vi.fn();
    const onOpenResourceReports = vi.fn();
    render(
      <NewMigrationEstimateModal
        client={client([])}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        onOpenServices={onOpenServices}
        onOpenResourceReports={onOpenResourceReports}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Create a service" }));
    expect(onOpenServices).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open resource reports" }));
    expect(onOpenResourceReports).toHaveBeenCalled();
    expect(screen.queryByLabelText("Service")).toBeNull();
    expect(screen.queryByRole("button", { name: "Estimate" })).toBeNull();
  });

  it("offers the service picker once there are services", async () => {
    render(
      <NewMigrationEstimateModal
        client={client([{ id: "svc_1", name: "checkout-api" }])}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        onOpenServices={vi.fn()}
      />,
    );
    expect(await screen.findByRole("option", { name: "checkout-api" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create a service" })).toBeNull();
  });
});
