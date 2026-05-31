import { describe, expect, it, vi } from "vitest";

vi.mock("../invoke", () => ({ invoke: vi.fn() }));

describe("cloud-api barrel", () => {
  it("re-exports the focused cloud modules", async () => {
    const api = await import("../cloud-api");
    // A representative export from each split module.
    expect(typeof api.getCloudAuthStatus).toBe("function"); // cloud-auth
    expect(typeof api.listCloudAccounts).toBe("function"); // cloud-accounts
    expect(typeof api.getCloudResourceDetail).toBe("function"); // cloud-resources
  });
});
