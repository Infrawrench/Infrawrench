import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { getCloudAuthStatus, getCloudOrgs, startCloudAuth } from "../cloud-auth";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("cloud-auth wrappers", () => {
  it("getCloudAuthStatus -> cloud_auth_status", async () => {
    invoke.mockResolvedValue({ authenticated: true, email: "a@b.c" });
    const res = await getCloudAuthStatus();
    expect(invoke).toHaveBeenCalledWith("cloud_auth_status");
    expect(res).toEqual({ authenticated: true, email: "a@b.c" });
  });

  it("startCloudAuth -> cloud_auth_start", async () => {
    await startCloudAuth();
    expect(invoke).toHaveBeenCalledWith("cloud_auth_start");
  });

  it("getCloudOrgs -> cloud_auth_orgs", async () => {
    invoke.mockResolvedValue([{ id: "o1", displayName: "Org", role: "owner" }]);
    const res = await getCloudOrgs();
    expect(invoke).toHaveBeenCalledWith("cloud_auth_orgs");
    expect(res).toHaveLength(1);
  });
});
