import { describe, expect, it } from "vitest";
import { runPluginRenderingTests } from "@infrawrench/plugin-base/test-harness";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import { WorkosClient } from "../client.js";

runPluginRenderingTests(plugin);

const ACCOUNT = "acct-1";

function client() {
  return new WorkosClient({ apiKey: "sk_test_key" });
}

function resource(overrides: Partial<ResourceInstance> & { resourceTypeId: string }) {
  const now = "2026-08-01T00:00:00.000Z";
  return {
    id: `${ACCOUNT}:${overrides.resourceTypeId}:ext`,
    pluginId: "workos",
    accountId: ACCOUNT,
    displayName: "Test",
    fields: {},
    resolvedOutputs: {},
    secretStates: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as ResourceInstance;
}

describe("organization detail", () => {
  it("renders the stashed domains table with verification state", () => {
    const schema = client().renderDetail(
      resource({
        resourceTypeId: "organization",
        displayName: "Acme",
        fields: { name: "Acme", organizationId: "org_1", domains: "acme.com" },
        resolvedOutputs: {
          organizationId: "org_1",
          __domains__: JSON.stringify([
            { domain: "acme.com", state: "verified" },
            { domain: "acme.dev", state: "pending" },
          ]),
        },
      }),
    );

    const domainsSection = schema.sections.find((section) => section.title === "Domains");
    expect(domainsSection).toBeDefined();
    const table = domainsSection!.children[0];
    expect(table).toMatchObject({ kind: "table" });
    expect((table as { rows: Array<{ cells: Record<string, string> }> }).rows).toEqual([
      { cells: { domain: "acme.com", state: "verified" } },
      { cells: { domain: "acme.dev", state: "pending" } },
    ]);
  });

  it("survives a malformed domains stash", () => {
    const schema = client().renderDetail(
      resource({
        resourceTypeId: "organization",
        fields: { name: "Acme", organizationId: "org_1" },
        resolvedOutputs: { __domains__: "not json" },
      }),
    );
    expect(schema.sections.find((section) => section.title === "Domains")).toBeUndefined();
  });
});

describe("membership detail", () => {
  it("offers Deactivate on active manual memberships", () => {
    const schema = client().renderDetail(
      resource({
        resourceTypeId: "organization-membership",
        fields: { status: "active", directoryManaged: false, role: "admin" },
      }),
    );
    const labels = (schema.headerActions ?? []).map((action) => action.label);
    expect(labels).toContain("Deactivate");
    expect(labels).not.toContain("Reactivate");
  });

  it("offers Reactivate on inactive memberships", () => {
    const schema = client().renderDetail(
      resource({
        resourceTypeId: "organization-membership",
        fields: { status: "inactive", directoryManaged: false },
      }),
    );
    const labels = (schema.headerActions ?? []).map((action) => action.label);
    expect(labels).toContain("Reactivate");
    expect(labels).not.toContain("Deactivate");
  });

  it("hides lifecycle actions on directory-managed memberships", () => {
    const schema = client().renderDetail(
      resource({
        resourceTypeId: "organization-membership",
        fields: { status: "active", directoryManaged: true },
      }),
    );
    const labels = (schema.headerActions ?? []).map((action) => action.label);
    expect(labels).not.toContain("Deactivate");
    expect(labels).not.toContain("Reactivate");
  });
});

describe("invitation detail", () => {
  it("offers Resend and Revoke only while pending", () => {
    const pending = client().renderDetail(
      resource({ resourceTypeId: "invitation", fields: { state: "pending" } }),
    );
    const pendingLabels = (pending.headerActions ?? []).map((action) => action.label);
    expect(pendingLabels).toContain("Resend");
    expect(pendingLabels).toContain("Revoke");

    const accepted = client().renderDetail(
      resource({ resourceTypeId: "invitation", fields: { state: "accepted" } }),
    );
    const acceptedLabels = (accepted.headerActions ?? []).map((action) => action.label);
    expect(acceptedLabels).not.toContain("Resend");
    expect(acceptedLabels).not.toContain("Revoke");
  });
});

describe("sidebar status dots", () => {
  it("maps directory states onto host statuses", () => {
    const cases: Array<[string, string]> = [
      ["linked", "healthy"],
      ["validating", "provisioning"],
      ["invalid_credentials", "error"],
      ["unlinked", "degraded"],
    ];
    for (const [state, expected] of cases) {
      const item = client().renderSidebarItem(
        resource({ resourceTypeId: "directory", fields: { state } }),
      );
      expect(item.status?.status).toBe(expected);
    }
  });

  it("marks disabled webhook endpoints as degraded", () => {
    const item = client().renderSidebarItem(
      resource({ resourceTypeId: "webhook-endpoint", fields: { status: "disabled" } }),
    );
    expect(item.status?.status).toBe("degraded");
  });
});

describe("role detail", () => {
  it("renders permissions as a table", () => {
    const schema = client().renderDetail(
      resource({
        resourceTypeId: "role",
        fields: { slug: "editor", name: "Editor", permissions: "posts:read, posts:write" },
      }),
    );
    const section = schema.sections.find((s) => s.title === "Permissions");
    expect(section).toBeDefined();
    expect(
      (section!.children[0] as { rows: Array<{ cells: Record<string, string> }> }).rows,
    ).toEqual([{ cells: { permission: "posts:read" } }, { cells: { permission: "posts:write" } }]);
  });
});
