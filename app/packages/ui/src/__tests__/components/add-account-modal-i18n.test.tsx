import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Stand in for a translated catalog: every plugin data string comes back
// marked, so a field rendered without the lookup shows up in English.
vi.mock("../../i18n/data-strings.js", () => ({
  useDataString: () => (value: string) => `fr:${value}`,
}));

const { AddAccountModal } = await import("../../components/AddAccountModal.js");
type PluginInfo = import("../../components/AddAccountModal.js").PluginInfo;

beforeAll(() => {
  // jsdom doesn't implement <dialog> showModal/close.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

const plugin: PluginInfo = {
  id: "acme",
  displayName: "Acme",
  logoSvg: "",
  credentialFields: [
    {
      key: "apiKey",
      label: "API key",
      description: "Create one under Settings.",
      placeholder: "acme_…",
      sensitive: true,
      helpLink: { label: "Create a key", url: "https://acme.example/keys" },
    },
    { key: "notes", label: "Notes", placeholder: "Anything", multiline: true },
  ],
};

describe("AddAccountModal", () => {
  it("translates the plugin's credential labels, descriptions, placeholders and help links", async () => {
    render(
      <AddAccountModal
        onClose={() => {}}
        onAdded={() => {}}
        loadPlugins={async () => [plugin]}
        saveAccount={async () => {}}
        prefilledPluginId="acme"
        prefilledDisplayName="Production"
      />,
    );

    const key = (await screen.findByLabelText("fr:API key")) as HTMLInputElement;
    expect(key.placeholder).toBe("fr:acme_…");
    expect(screen.getByText("fr:Create one under Settings.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "fr:Create a key" })).toBeInTheDocument();
    expect((screen.getByLabelText("fr:Notes") as HTMLTextAreaElement).placeholder).toBe(
      "fr:Anything",
    );
    expect(screen.queryByText("API key")).toBeNull();
  });
});
