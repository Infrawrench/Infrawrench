import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { describeLanding } from "../cli/commands/dashboards";

describe("dashboards CLI: your default", () => {
  it("says which layer the default came from", () => {
    expect(describeLanding({ source: "user", roleDefault: null })).toBe("your choice");
    expect(describeLanding({ source: "role", roleDefault: { roleName: "Finance" } })).toBe(
      "default for the Finance role",
    );
    expect(describeLanding({ source: "org", roleDefault: null })).toBe("organization default");
  });
});
