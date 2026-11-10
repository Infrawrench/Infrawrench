import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PolicyTemplate, PreflightDeclaration } from "@infrawrench/client-core";
import { AddAccountModal, type PluginInfo } from "../../components/AddAccountModal.js";
import {
  ConnectionProductsNotice,
  ConnectionProductsPicker,
  selectedConnectionProducts,
} from "../../components/ConnectionProducts.js";
import { CredentialPreflightPanel } from "../../components/CredentialPreflightPanel.js";

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

const permission = (id: string) => [{ id, label: id }];

/** Offers Infrastructure, Costs and Observability. */
const declaration: PreflightDeclaration = {
  capabilities: [
    { id: "resources", label: "Resource inventory", requiredPermissions: permission("list") },
    { id: "metrics", label: "Metrics", requiredPermissions: permission("metrics") },
    { id: "costs", label: "Cost reporting", requiredPermissions: permission("billing") },
    { id: "idle-findings", label: "Idle findings", requiredPermissions: permission("idle") },
  ],
  templateFormat: { label: "Policy (JSON)", language: "json" },
};

const plugin: PluginInfo = {
  id: "cloud",
  displayName: "Cloud",
  logoSvg: "<svg></svg>",
  credentialFields: [{ key: "apiToken", label: "API token", sensitive: true }],
  preflight: declaration,
};

const template = (ids: string[]): PolicyTemplate => ({
  formatLabel: "Policy (JSON)",
  language: "json",
  document: `policy for ${ids.join("+")}`,
});

describe("ConnectionProductsPicker", () => {
  it("offers one checkbox per app the plugin's capabilities power", () => {
    render(
      <ConnectionProductsPicker
        declaration={declaration}
        value={["infrastructure", "costs", "observability"]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByLabelText("Infrastructure")).toBeChecked();
    expect(screen.getByLabelText("Costs")).toBeChecked();
    expect(screen.getByLabelText("Observability")).toBeChecked();
    expect(screen.queryByLabelText("Security")).toBeNull();
  });

  it("reports the selection in the canonical order", () => {
    const onChange = vi.fn();
    render(
      <ConnectionProductsPicker declaration={declaration} value={["costs"]} onChange={onChange} />,
    );
    fireEvent.click(screen.getByLabelText("Infrastructure"));
    expect(onChange).toHaveBeenCalledWith(["infrastructure", "costs"]);
  });

  it("does not let the last app be unchecked", () => {
    render(
      <ConnectionProductsPicker declaration={declaration} value={["costs"]} onChange={() => {}} />,
    );
    expect(screen.getByLabelText("Costs")).toBeDisabled();
    expect(screen.getByLabelText("Infrastructure")).not.toBeDisabled();
  });

  it("renders nothing when the plugin offers a single app", () => {
    const { container } = render(
      <ConnectionProductsPicker
        declaration={{ capabilities: [declaration.capabilities[0]!] }}
        value={["infrastructure"]}
        onChange={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("selectedConnectionProducts", () => {
  it("reads null as everything the plugin offers", () => {
    expect(selectedConnectionProducts(declaration, null)).toEqual([
      "infrastructure",
      "costs",
      "observability",
    ]);
  });

  it("drops what the plugin does not offer", () => {
    expect(selectedConnectionProducts(declaration, ["costs", "security", "nope"])).toEqual([
      "costs",
    ]);
  });
});

describe("ConnectionProductsNotice", () => {
  it("explains a costs-only connection", () => {
    render(<ConnectionProductsNotice products={["costs"]} />);
    expect(screen.getByText("Connected for Costs only")).toBeInTheDocument();
  });

  it("renders nothing for a connection that syncs resources", () => {
    const { container } = render(
      <>
        <ConnectionProductsNotice products={null} />
        <ConnectionProductsNotice products={undefined} />
        <ConnectionProductsNotice products={["costs", "observability"]} />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("CredentialPreflightPanel scoped to apps", () => {
  it("lists only the capabilities the chosen apps need, without checkboxes", async () => {
    const fetchPolicyTemplate = vi.fn(async (ids: string[]) => template(ids));
    render(
      <CredentialPreflightPanel
        declaration={declaration}
        products={["costs"]}
        fetchPolicyTemplate={fetchPolicyTemplate}
      />,
    );
    expect(screen.getByText("Cost reporting")).toBeInTheDocument();
    expect(screen.getByText("Idle findings")).toBeInTheDocument();
    expect(screen.queryByText("Resource inventory")).toBeNull();

    fireEvent.click(screen.getByText(/Generate least-privilege/));
    await screen.findByText("policy for costs+idle-findings");
    expect(fetchPolicyTemplate).toHaveBeenCalledWith(["costs", "idle-findings"]);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("rebuilds an open template when the apps change", async () => {
    const fetchPolicyTemplate = vi.fn(async (ids: string[]) => template(ids));
    const { rerender } = render(
      <CredentialPreflightPanel
        declaration={declaration}
        products={["costs"]}
        fetchPolicyTemplate={fetchPolicyTemplate}
      />,
    );
    fireEvent.click(screen.getByText(/Generate least-privilege/));
    await screen.findByText("policy for costs+idle-findings");

    rerender(
      <CredentialPreflightPanel
        declaration={declaration}
        products={["costs", "observability"]}
        fetchPolicyTemplate={fetchPolicyTemplate}
      />,
    );
    await screen.findByText("policy for metrics+costs+idle-findings");
  });

  it("reads null as every app", () => {
    render(<CredentialPreflightPanel declaration={declaration} products={null} />);
    expect(screen.getAllByText(/Not checked yet/)).toHaveLength(4);
  });
});

describe("AddAccountModal: a connection is for chosen apps", () => {
  function renderModal(saveAccount = vi.fn().mockResolvedValue(undefined)) {
    const fetchPolicyTemplate = vi.fn(async (_pluginId: string, ids: string[]) => template(ids));
    render(
      <AddAccountModal
        onClose={vi.fn()}
        onAdded={vi.fn()}
        loadPlugins={async () => [plugin]}
        saveAccount={saveAccount}
        fetchPolicyTemplate={fetchPolicyTemplate}
        prefilledPluginId="cloud"
      />,
    );
    return { saveAccount, fetchPolicyTemplate };
  }

  async function fillAndSave() {
    fireEvent.change(screen.getByLabelText("Account name"), { target: { value: "Billing" } });
    fireEvent.change(document.getElementById("add-account-field-apiToken")!, {
      target: { value: "token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
  }

  it("starts with every app checked and saves null for all of them", async () => {
    const { saveAccount } = renderModal();
    expect(await screen.findByLabelText("Costs")).toBeChecked();
    expect(screen.getByLabelText("Infrastructure")).toBeChecked();

    await fillAndSave();

    await waitFor(() => expect(saveAccount).toHaveBeenCalled());
    expect(saveAccount.mock.calls[0]![4]).toBeNull();
  });

  it("saves the chosen apps and scopes the template to their capabilities", async () => {
    const { saveAccount, fetchPolicyTemplate } = renderModal();
    fireEvent.click(await screen.findByLabelText("Infrastructure"));
    fireEvent.click(screen.getByLabelText("Observability"));

    fireEvent.click(screen.getByText(/Generate least-privilege/));
    await screen.findByText("policy for costs+idle-findings");
    expect(fetchPolicyTemplate).toHaveBeenLastCalledWith("cloud", ["costs", "idle-findings"]);

    await fillAndSave();

    await waitFor(() => expect(saveAccount).toHaveBeenCalled());
    expect(saveAccount.mock.calls[0]![4]).toEqual(["costs"]);
  });

  it("shows no picker and saves null for a plugin without a choice", async () => {
    const saveAccount = vi.fn().mockResolvedValue(undefined);
    render(
      <AddAccountModal
        onClose={vi.fn()}
        onAdded={vi.fn()}
        loadPlugins={async () => [{ ...plugin, preflight: null }]}
        saveAccount={saveAccount}
        prefilledPluginId="cloud"
      />,
    );
    await screen.findByLabelText("Account name");
    expect(screen.queryByText("Use this connection for")).toBeNull();

    await fillAndSave();

    await waitFor(() => expect(saveAccount).toHaveBeenCalled());
    expect(saveAccount.mock.calls[0]![4]).toBeNull();
  });
});
