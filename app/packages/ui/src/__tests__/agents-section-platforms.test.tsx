import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentLinkSummary, AgentRegistration } from "@infrawrench/client-core";
import { AgentsSection } from "../settings/AgentsSection.js";
import { SettingsHostProvider, type SettingsHostValue } from "../settings/host.js";

/**
 * Settings → Agents' "Connected platforms": each agent link with its ceiling
 * and its agents nested under it, a Revoke on the link, and Edit scopes on each
 * agent held to that link's ceiling.
 */
const link: AgentLinkSummary = {
  id: "link-1",
  organizationId: "org-1",
  organizationName: "Acme",
  platform: "nibblets",
  label: "Nibblets on PogAir-4",
  scopes: ["resources:read", "costs:read"],
  effectiveScopes: ["resources:read", "costs:read"],
  narrowableScopes: ["resources:read"],
  scopeGroups: [],
  providers: [{ id: "aws", displayName: "AWS" }],
  approvedBy: { email: "astrid@example.com" },
  createdAt: new Date().toISOString(),
  credentialPrefix: "iwl_abcd",
  lastSeenAt: null,
  revokedAt: null,
};

const base = {
  kind: "platform",
  prefix: "iwa_abcd",
  claimedAt: new Date().toISOString(),
  claimedByUserId: "user_1",
  claimedByEmail: "astrid@example.com",
  lastSeenAt: null,
  revokedAt: null,
  createdAt: new Date().toISOString(),
};
const agents: AgentRegistration[] = [
  {
    ...base,
    id: "reg-1",
    label: "Pog",
    linkId: "link-1",
    externalId: "nib-1",
    scopes: ["resources:read"],
    providers: [],
  },
  {
    ...base,
    id: "reg-2",
    label: "Trial helper",
    kind: "anonymous",
    linkId: null,
    externalId: null,
    scopes: null,
    providers: null,
  },
];

function renderSection(calls: Array<{ method: string; path: string; body?: unknown }>) {
  const host = {
    orgId: "org-1",
    api: {
      async get<T>(path: string): Promise<T> {
        return (path.endsWith("/agent-links") ? [link] : agents) as T;
      },
      async post<T>(): Promise<T> {
        return {} as T;
      },
      async put<T>(): Promise<T> {
        return {} as T;
      },
      async patch<T>(path: string, body?: unknown): Promise<T> {
        calls.push({ method: "PATCH", path, body });
        return {} as T;
      },
      async delete<T>(path: string): Promise<T> {
        calls.push({ method: "DELETE", path });
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
      <AgentsSection />
    </SettingsHostProvider>,
  );
}

describe("Settings → Agents connected platforms", () => {
  it("nests a platform's agents under it and keeps claimed agents apart", async () => {
    renderSection([]);
    expect(await screen.findByText("Nibblets on PogAir-4")).toBeTruthy();
    expect(screen.getByText("Pog")).toBeTruthy();
    expect(screen.getByText("Trial helper")).toBeTruthy();
    expect(screen.getByText("Claimed agents")).toBeTruthy();
  });

  it("revokes the link through the org tree", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    renderSection(calls);
    const card = (await screen.findByText("Nibblets on PogAir-4")).closest("div.border")!;
    fireEvent.click(within(card as HTMLElement).getAllByRole("button", { name: "Revoke" })[0]!);
    await waitFor(() =>
      expect(calls).toContainEqual({ method: "DELETE", path: "/api/org/org-1/agent-links/link-1" }),
    );
  });

  it("edits an agent's scopes within the link ceiling", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    renderSection(calls);
    fireEvent.click(await screen.findByRole("button", { name: "Edit scopes" }));
    // Only the link's ceiling is offered.
    expect(screen.getByLabelText("Costs (read)")).toBeTruthy();
    expect(screen.queryByLabelText("Resources (write)")).toBeNull();
    fireEvent.click(screen.getByLabelText("Costs (read)"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "PATCH",
        path: "/api/org/org-1/agent-registrations/reg-1",
        body: { scopes: ["resources:read", "costs:read"], providers: [] },
      }),
    );
  });

  it("offers only provider-limitable scopes once providers are chosen", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    renderSection(calls);
    fireEvent.click(await screen.findByRole("button", { name: "Edit scopes" }));
    fireEvent.click(screen.getByLabelText("Costs (read)"));
    fireEvent.click(screen.getByLabelText("AWS"));
    // Costs cannot be limited to AWS, so it is no longer offered or sent.
    expect(screen.queryByLabelText("Costs (read)")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "PATCH",
        path: "/api/org/org-1/agent-registrations/reg-1",
        body: { scopes: ["resources:read"], providers: ["aws"] },
      }),
    );
  });
});
