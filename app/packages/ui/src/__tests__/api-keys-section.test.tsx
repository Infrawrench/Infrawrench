import { beforeAll, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

beforeAll(() => {
  // jsdom doesn't implement <dialog> showModal/close — same stub the other
  // Modal-based section tests install.
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

import { ApiKeysSection } from "../settings/ApiKeysSection.js";
import { SettingsHostProvider, type SettingsHostValue } from "../settings/host.js";

/**
 * The Create API Key dialog is the only way to mint a key, so what it offers is
 * the ceiling on what any key in the org can do. It used to offer eleven scopes
 * out of a catalog of sixty-four, which left the cost surface — the Terraform
 * provider's whole reason for holding a key — unselectable however the docs
 * described it. These tests are about the dialog producing the scopes, not
 * about the list's contents (`api-key-scopes.test.ts` covers those).
 */
function renderSection(posted: { path?: string; body?: unknown }) {
  const host = {
    orgId: "org-1",
    api: {
      async get<T>(): Promise<T> {
        return [] as T;
      },
      async post<T>(path: string, body?: unknown): Promise<T> {
        posted.path = path;
        posted.body = body;
        return { id: "key-1", key: "iwk_plaintext" } as T;
      },
      async put<T>(): Promise<T> {
        return {} as T;
      },
      async patch<T>(): Promise<T> {
        return {} as T;
      },
      async delete<T>(): Promise<T> {
        return {} as T;
      },
    },
    has: () => true,
    hasAny: () => true,
    permissionsLoading: false,
    async refreshPermissions() {},
    async fetchText() {
      return "";
    },
    openWorkspace() {},
    openSection() {},
    openExternal() {},
    onAccountDeleted() {},
    approvals: {},
  } as unknown as SettingsHostValue;

  return render(
    <SettingsHostProvider value={host}>
      <ApiKeysSection />
    </SettingsHostProvider>,
  );
}

async function openDialog() {
  fireEvent.click(await screen.findByRole("button", { name: "Create API Key" }));
  return screen.findByLabelText("Name");
}

describe("Create API Key dialog", () => {
  it("mints a key carrying the cost scopes the Terraform provider needs", async () => {
    const posted: { path?: string; body?: unknown } = {};
    renderSection(posted);

    fireEvent.change(await openDialog(), { target: { value: "terraform" } });
    fireEvent.click(screen.getByLabelText("Costs (read)"));
    fireEvent.click(screen.getByLabelText("Costs (write)"));
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));

    await waitFor(() => expect(posted.body).toBeDefined());
    expect(posted.path).toBe("/api/org/org-1/api-keys");
    expect((posted.body as { scopes: string[] }).scopes).toEqual(["costs:read", "costs:write"]);
  });

  it("filters by the permission string, which is what the docs quote", async () => {
    renderSection({});
    await openDialog();

    expect(screen.getByLabelText("Resources (read)")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter scopes"), { target: { value: "budgets:" } });

    expect(screen.getByLabelText("Budgets (read)")).toBeInTheDocument();
    expect(screen.getByLabelText("Budgets (write)")).toBeInTheDocument();
    expect(screen.queryByLabelText("Resources (read)")).not.toBeInTheDocument();
  });

  it("keeps a scope selected after it is filtered out of view", async () => {
    const posted: { path?: string; body?: unknown } = {};
    renderSection(posted);

    fireEvent.change(await openDialog(), { target: { value: "mixed" } });
    fireEvent.click(screen.getByLabelText("Costs (read)"));

    fireEvent.change(screen.getByLabelText("Filter scopes"), { target: { value: "ssh" } });
    fireEvent.click(screen.getByLabelText("SSH keys (read)"));
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));

    await waitFor(() => expect(posted.body).toBeDefined());
    expect((posted.body as { scopes: string[] }).scopes).toEqual(["costs:read", "ssh-keys:read"]);
  });

  it("refuses to mint a key with no scopes at all", async () => {
    const posted: { path?: string; body?: unknown } = {};
    renderSection(posted);

    fireEvent.change(await openDialog(), { target: { value: "empty" } });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Select at least one scope");
    expect(posted.body).toBeUndefined();
  });

  /**
   * `sync:read` / `sync:write` are rewritten to `resources:*` the next time a
   * key carrying them authenticates, so offering them mints a key whose stored
   * scopes change under it.
   */
  it("no longer offers the deprecated sync scopes", async () => {
    renderSection({});
    await openDialog();
    expect(screen.queryByLabelText("Sync (read)")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Sync (write)")).not.toBeInTheDocument();
  });
});
