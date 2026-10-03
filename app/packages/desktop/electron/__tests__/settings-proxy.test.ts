import { describe, expect, it, vi } from "vitest";
import { isAllowedSettingsRequest } from "../cloud-data/settings";

// Hoisted above the import: the module registers its IPC handler on load.
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../cloud-auth", () => ({
  getAccessToken: vi.fn(),
  forceRefreshAccessToken: vi.fn(),
}));

describe("isAllowedSettingsRequest", () => {
  it("allows settings routes", () => {
    expect(isAllowedSettingsRequest("GET", "/api/profile")).toBe(true);
    expect(isAllowedSettingsRequest("patch", "/api/org/o1/team/m1")).toBe(true);
    expect(isAllowedSettingsRequest("GET", "/api/org/o1/audit-logs?limit=50")).toBe(true);
  });

  it("refuses routes off the surface", () => {
    expect(isAllowedSettingsRequest("GET", "/api/org/o1/resources")).toBe(false);
    expect(isAllowedSettingsRequest("DELETE", "/api/org/o1/audit-logs")).toBe(false);
  });

  it("refuses dot segments that fetch would resolve off the surface", () => {
    expect(isAllowedSettingsRequest("GET", "/api/profile/../org/o1/resources")).toBe(false);
    expect(isAllowedSettingsRequest("DELETE", "/api/org/o1/team/../../o1/accounts/a1")).toBe(false);
    expect(isAllowedSettingsRequest("GET", "/api/profile/./x")).toBe(false);
  });

  it("refuses encoded dots, slashes and backslashes", () => {
    expect(isAllowedSettingsRequest("GET", "/api/profile/%2e%2e/org/o1/resources")).toBe(false);
    expect(isAllowedSettingsRequest("GET", "/api/profile%2F..%2Forg")).toBe(false);
    expect(isAllowedSettingsRequest("GET", "/api/profile/..\\org")).toBe(false);
  });

  it("refuses anything that is not an origin-relative path", () => {
    expect(isAllowedSettingsRequest("GET", "//evil.example/api/profile")).toBe(false);
    expect(isAllowedSettingsRequest("GET", "https://evil.example/api/profile")).toBe(false);
    expect(isAllowedSettingsRequest("GET", "api/profile")).toBe(false);
  });
});
