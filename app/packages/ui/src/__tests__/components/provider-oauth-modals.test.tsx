import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddAccountModal, type PluginInfo } from "../../components/AddAccountModal.js";
import { EditCredentialsModal } from "../../components/EditCredentialsModal.js";

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

const plugin: PluginInfo = {
  id: "acme",
  displayName: "Acme",
  logoSvg: "<svg></svg>",
  credentialFields: [
    { key: "apiToken", label: "API token", sensitive: true },
    { key: "teamId", label: "Team" },
  ],
  oauth: { access: "full", refresh: "rotating", tokenField: "apiToken" },
};

describe("AddAccountModal provider OAuth", () => {
  it("hides Connect without a connectOAuth host callback", async () => {
    render(
      <AddAccountModal
        onClose={vi.fn()}
        onAdded={vi.fn()}
        loadPlugins={async () => [plugin]}
        saveAccount={vi.fn()}
        prefilledPluginId="acme"
      />,
    );
    await screen.findByLabelText("API token");
    expect(screen.queryByRole("button", { name: "Connect with Acme" })).toBeNull();
  });

  it("connects, pre-fills, and saves the grant with the form", async () => {
    const saveAccount = vi.fn().mockResolvedValue(undefined);
    const connectOAuth = vi.fn().mockResolvedValue({
      credentials: { apiToken: "at_1", __oauth: "sealed", teamId: "team-9" },
      accountName: "Acme Corp",
    });
    render(
      <AddAccountModal
        onClose={vi.fn()}
        onAdded={vi.fn()}
        loadPlugins={async () => [plugin]}
        saveAccount={saveAccount}
        connectOAuth={connectOAuth}
        prefilledPluginId="acme"
      />,
    );
    const connect = await screen.findByRole("button", { name: "Connect with Acme" });
    expect(screen.getByText(/only offers full-access tokens/)).toBeInTheDocument();
    fireEvent.click(connect);
    expect(connectOAuth).toHaveBeenCalledWith("acme", {});

    await screen.findByText("Connected to Acme");
    expect(document.getElementById("add-account-field-apiToken")).toBeNull();
    expect(screen.getByLabelText("Account name")).toHaveValue("Acme Corp");
    expect(screen.getByLabelText("Team")).toHaveValue("team-9");

    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    await waitFor(() => expect(saveAccount).toHaveBeenCalled());
    expect(saveAccount).toHaveBeenCalledWith(
      "acme",
      "Acme Corp",
      { apiToken: "at_1", __oauth: "sealed", teamId: "team-9" },
      null,
    );
  });

  it("drops the grant when the user switches to a pasted token", async () => {
    const saveAccount = vi.fn().mockResolvedValue(undefined);
    render(
      <AddAccountModal
        onClose={vi.fn()}
        onAdded={vi.fn()}
        loadPlugins={async () => [plugin]}
        saveAccount={saveAccount}
        connectOAuth={async () => ({
          credentials: { apiToken: "at_1", __oauth: "sealed", teamId: "team-9" },
        })}
        prefilledPluginId="acme"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connect with Acme" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use a token instead" }));
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "pasted" } });
    fireEvent.change(screen.getByLabelText("Account name"), { target: { value: "Mine" } });
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    await waitFor(() => expect(saveAccount).toHaveBeenCalled());
    expect(saveAccount.mock.calls[0]![2]).toEqual({ apiToken: "pasted", teamId: "team-9" });
  });

  it("returns quietly to idle when the flow is cancelled", async () => {
    const abort = Object.assign(new Error("closed"), { name: "AbortError" });
    render(
      <AddAccountModal
        onClose={vi.fn()}
        onAdded={vi.fn()}
        loadPlugins={async () => [plugin]}
        saveAccount={vi.fn()}
        connectOAuth={() => Promise.reject(abort)}
        prefilledPluginId="acme"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connect with Acme" }));
    await screen.findByRole("button", { name: "Connect with Acme" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("EditCredentialsModal provider OAuth", () => {
  it("keeps the current token on an OAuth account saved without changes", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditCredentialsModal
        plugin={plugin}
        accountDisplayName="Acme Corp"
        currentCredentials={{ apiToken: "at_current", teamId: "team-9" }}
        oauthStatus="connected"
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Connected via OAuth")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({ apiToken: "at_current", teamId: "team-9" });
  });

  it("reconnects with the account id and saves the new grant", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const connectOAuth = vi.fn().mockResolvedValue({
      credentials: { apiToken: "at_new", __oauth: "sealed2" },
    });
    render(
      <EditCredentialsModal
        plugin={plugin}
        accountId="acc-1"
        accountDisplayName="Acme Corp"
        currentCredentials={{ apiToken: "at_old", teamId: "team-9" }}
        oauthStatus="reconnect_required"
        connectOAuth={connectOAuth}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Reconnect needed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(connectOAuth).toHaveBeenCalledWith("acme", { accountId: "acc-1" });
    await screen.findByText("Save to apply the new connection.");
    fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({
      apiToken: "at_new",
      __oauth: "sealed2",
      teamId: "team-9",
    });
  });

  it("requires a new token after Use a token instead", async () => {
    const onSave = vi.fn();
    render(
      <EditCredentialsModal
        plugin={plugin}
        accountDisplayName="Acme Corp"
        currentCredentials={{ apiToken: "at_current", teamId: "team-9" }}
        oauthStatus="connected"
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Use a token instead" }));
    fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));
    await screen.findByText("API token is required.");
    expect(onSave).not.toHaveBeenCalled();
  });
});
