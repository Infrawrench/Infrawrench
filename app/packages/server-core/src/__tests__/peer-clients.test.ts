import { describe, it, expect, vi } from "vitest";

// Mocked only to keep the module import side-effect free (the real db client
// throws without DATABASE_URL; the plugin loader loads every plugin).
vi.mock("../db/client", () => ({ db: {} }));
vi.mock("../plugin-loader", () => ({ getPlugin: vi.fn() }));
vi.mock("../host-services", () => ({ buildPluginHostServices: vi.fn() }));
vi.mock("../credential-rewriters", () => ({ applyCredentialRewriters: vi.fn() }));
vi.mock("../org-accounts", () => ({ getOrgAccountClient: vi.fn() }));

// getClientForResource's own behaviour needs a live account + plugin loader;
// what's unit-testable here is the declarative visibility gating.
const { filterVisiblePeerIntegrations } = await import("../peer-clients");

describe("filterVisiblePeerIntegrations", () => {
  it("keeps integrations with no gates", () => {
    const out = filterVisiblePeerIntegrations([{ pluginId: "x" } as never], {});
    expect(out).toHaveLength(1);
  });

  it("drops integrations whose requiresFields are unset", () => {
    const out = filterVisiblePeerIntegrations(
      [{ pluginId: "x", requiresFields: ["connectionName"] } as never],
      { connectionName: "" },
    );
    expect(out).toHaveLength(0);
  });

  it("keeps integrations whose requiresFields are present", () => {
    const out = filterVisiblePeerIntegrations(
      [{ pluginId: "x", requiresFields: ["connectionName"] } as never],
      { connectionName: "proj:region:inst" },
    );
    expect(out).toHaveLength(1);
  });

  it("applies showWhen equals matching", () => {
    const integration = { pluginId: "x", showWhen: { fieldKey: "engine", equals: "postgres" } };
    expect(
      filterVisiblePeerIntegrations([integration as never], { engine: "postgres" }),
    ).toHaveLength(1);
    expect(filterVisiblePeerIntegrations([integration as never], { engine: "mysql" })).toHaveLength(
      0,
    );
  });

  it("applies showWhen prefix matching", () => {
    const integration = { pluginId: "x", showWhen: { fieldKey: "engine", prefix: "POSTGRES" } };
    expect(
      filterVisiblePeerIntegrations([integration as never], { engine: "POSTGRES_14" }),
    ).toHaveLength(1);
    expect(
      filterVisiblePeerIntegrations([integration as never], { engine: "MYSQL_8" }),
    ).toHaveLength(0);
  });
});
