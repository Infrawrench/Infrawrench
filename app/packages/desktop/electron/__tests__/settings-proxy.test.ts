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
    // The Tag Keys section: the discovery table and the settings document.
    expect(isAllowedSettingsRequest("GET", "/api/org/o1/tag-keys")).toBe(true);
    expect(isAllowedSettingsRequest("PUT", "/api/org/o1/tag-keys/settings")).toBe(true);
    // The AI Attribution section: sources, locations picker, dimensions, stats.
    expect(
      isAllowedSettingsRequest(
        "GET",
        "/api/org/o1/ai-attribution/locations?accountId=a&sourceKindId=bedrock-s3",
      ),
    ).toBe(true);
    expect(isAllowedSettingsRequest("PUT", "/api/org/o1/ai-attribution/dimensions/d1")).toBe(true);
  });

  it("allows virtual tags and read-only business metrics", () => {
    expect(isAllowedSettingsRequest("GET", "/api/org/o1/virtual-tags")).toBe(true);
    expect(isAllowedSettingsRequest("POST", "/api/org/o1/virtual-tags/preview")).toBe(true);
    expect(isAllowedSettingsRequest("POST", "/api/org/o1/virtual-tags/t1/reprocess")).toBe(true);
    expect(isAllowedSettingsRequest("PUT", "/api/org/o1/virtual-tags/t1")).toBe(true);
    expect(isAllowedSettingsRequest("GET", "/api/org/o1/business-metrics")).toBe(true);
    expect(isAllowedSettingsRequest("POST", "/api/org/o1/business-metrics")).toBe(false);
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
