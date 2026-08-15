import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AuditLogSection } from "../settings/AuditLogSection.js";
import { SettingsHostProvider, type SettingsHostValue } from "../settings/host.js";

/**
 * A key acts as its owner, so an entry that shows only the owner cannot tell
 * you whether a person or a token was at the other end — the question you ask
 * first when a credential leaks. These tests pin that the key's own identity
 * reaches the screen, that a key whose row is gone still reads as something,
 * and that the log can be narrowed to one credential.
 */

interface AuditRow {
  id: string;
  userId: string | null;
  apiKeyId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: unknown;
  ipAddress: string | null;
  createdAt: string;
  userName: string | null;
  userEmail: string | null;
  apiKeyName: string | null;
  apiKeyPrefix: string | null;
}

function row(over: Partial<AuditRow>): AuditRow {
  return {
    id: "e1",
    userId: null,
    apiKeyId: null,
    action: "resource.create",
    entityType: "resource",
    entityId: "00000000-0000-0000-0000-000000000000",
    metadata: null,
    ipAddress: null,
    createdAt: "2026-01-02T03:04:05.000Z",
    userName: null,
    userEmail: null,
    apiKeyName: null,
    apiKeyPrefix: null,
    ...over,
  };
}

const KEYS = [
  { id: "key-1", name: "ci-deploy", prefix: "iwk_abc12345", revokedAt: null },
  { id: "key-2", name: "reporting", prefix: "iwk_def67890", revokedAt: null },
];

function buildHost(
  entries: AuditRow[],
  requests: string[],
  opts: { canReadKeys?: boolean; permissionsLoading?: boolean } = {},
) {
  const host = {
    orgId: "org-1",
    api: {
      async get<T>(path: string): Promise<T> {
        requests.push(path);
        if (path.includes("/api-keys")) return KEYS as T;
        const apiKeyId = new URL(path, "https://x").searchParams.get("apiKeyId");
        const visible = apiKeyId ? entries.filter((e) => e.apiKeyId === apiKeyId) : entries;
        return { entries: visible, total: visible.length } as T;
      },
      async post<T>(): Promise<T> {
        return {} as T;
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
    has: (p: string) => (p === "apikeys:read" ? (opts.canReadKeys ?? true) : true),
    hasAny: () => true,
    permissionsLoading: opts.permissionsLoading ?? false,
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
  return host;
}

function renderSection(entries: AuditRow[], opts: { canReadKeys?: boolean } = {}) {
  const requests: string[] = [];
  render(
    <SettingsHostProvider value={buildHost(entries, requests, opts)}>
      <AuditLogSection />
    </SettingsHostProvider>,
  );
  return requests;
}

describe("AuditLogSection actor column", () => {
  it("names the key and its prefix, alongside the owner", async () => {
    renderSection([
      row({
        apiKeyId: "key-1",
        apiKeyName: "ci-deploy",
        apiKeyPrefix: "iwk_abc12345",
        userId: "u1",
        userName: "Alice",
      }),
    ]);

    expect(await screen.findByText("ci-deploy")).toBeTruthy();
    expect(screen.getByText("iwk_abc12345…")).toBeTruthy();
    // The owner is kept — a key acts as its owner — but as the secondary line.
    expect(screen.getByText("Owned by Alice")).toBeTruthy();
    // And it is visibly a key, not a person.
    expect(screen.getByText("API key")).toBeTruthy();
  });

  it("still says something when the key row has been deleted", async () => {
    renderSection([row({ apiKeyId: "key-gone", userId: "u1", userName: "Alice" })]);

    expect(await screen.findByText("Deleted key")).toBeTruthy();
    expect(screen.getByText("Owned by Alice")).toBeTruthy();
  });

  it("renders a human actor as plain text, with no key chip", async () => {
    renderSection([row({ userId: "u1", userName: "Alice" })]);

    expect(await screen.findByText("Alice")).toBeTruthy();
    expect(screen.queryByText("API key")).toBeNull();
  });

  it("falls back to System when nobody is attributed", async () => {
    renderSection([row({})]);
    expect(await screen.findByText("System")).toBeTruthy();
  });
});

describe("AuditLogSection API key filter", () => {
  it("clicking the chip refetches with apiKeyId and selects that key", async () => {
    const requests = renderSection([
      row({ id: "e1", apiKeyId: "key-1", apiKeyName: "ci-deploy", apiKeyPrefix: "iwk_abc12345" }),
      row({ id: "e2", userId: "u1", userName: "Alice" }),
    ]);

    fireEvent.click(await screen.findByTitle("Show only this API key"));

    await waitFor(() => expect(requests.some((p) => p.includes("apiKeyId=key-1"))).toBe(true));
    const select = (await screen.findByLabelText("Filter by API key")) as HTMLSelectElement;
    expect(select.value).toBe("key-1");
    // The human entry is gone; only the key's own actions remain.
    await waitFor(() => expect(screen.queryByText("Alice")).toBeNull());
  });

  it("offers the org's keys in the dropdown and clears back to everything", async () => {
    const requests = renderSection([
      row({ id: "e1", apiKeyId: "key-1", apiKeyName: "ci-deploy", apiKeyPrefix: "iwk_abc12345" }),
    ]);

    const select = (await screen.findByLabelText("Filter by API key")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "All API keys",
      "ci-deploy (iwk_abc12345…)",
      "reporting (iwk_def67890…)",
    ]);

    fireEvent.change(select, { target: { value: "key-2" } });
    await waitFor(() => expect(requests.some((p) => p.includes("apiKeyId=key-2"))).toBe(true));

    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() =>
      expect(requests.filter((p) => p.includes("audit-logs")).at(-1)).not.toContain("apiKeyId"),
    );
  });

  /**
   * Reading audit entries and listing the org's keys are separate permissions.
   * Without the second one there is no dropdown to start from, so the chip has
   * to carry the filter — including the way back out of it.
   */
  it("without apikeys:read, the chip still filters and the filter can be cleared", async () => {
    const requests = renderSection(
      [row({ apiKeyId: "key-1", apiKeyName: "ci-deploy", apiKeyPrefix: "iwk_abc12345" })],
      { canReadKeys: false },
    );

    await screen.findByText("ci-deploy");
    expect(requests.some((p) => p.includes("/api-keys"))).toBe(false);
    expect(screen.queryByLabelText("Filter by API key")).toBeNull();

    fireEvent.click(screen.getByTitle("Show only this API key"));

    const select = (await screen.findByLabelText("Filter by API key")) as HTMLSelectElement;
    expect(select.value).toBe("key-1");
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "All API keys",
      "ci-deploy (iwk_abc12345…)",
    ]);

    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() =>
      expect(requests.filter((p) => p.includes("audit-logs")).at(-1)).not.toContain("apiKeyId"),
    );
  });

  /**
   * `has` answers false until the caller's role arrives. Fetching once on
   * mount would read that as a denial and never look again, leaving a
   * permitted reader with no dropdown.
   */
  it("waits for permissions to load before deciding it cannot list keys", async () => {
    const requests: string[] = [];
    const entries = [row({ apiKeyId: "key-1", apiKeyName: "ci-deploy", apiKeyPrefix: "iwk_abc" })];
    const { rerender } = render(
      <SettingsHostProvider value={buildHost(entries, requests, { permissionsLoading: true })}>
        <AuditLogSection />
      </SettingsHostProvider>,
    );

    await screen.findByText("ci-deploy");
    expect(requests.some((p) => p.includes("/api-keys"))).toBe(false);

    rerender(
      <SettingsHostProvider value={buildHost(entries, requests, { permissionsLoading: false })}>
        <AuditLogSection />
      </SettingsHostProvider>,
    );

    expect(await screen.findByLabelText("Filter by API key")).toBeTruthy();
  });
});
