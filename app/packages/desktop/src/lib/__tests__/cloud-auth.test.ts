import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);

const { fakeRpc, resetFakeRpc } = await import("./fake-rpc");
const { getCloudAuthStatus, getCloudOrgs, getCloudWsToken, startCloudAuth } =
  await import("../cloud-auth");
const { CloudRequestError } = await import("../../../shared/rpc/errors");

beforeEach(() => {
  resetFakeRpc();
});

describe("cloud-auth wrappers", () => {
  it("getCloudAuthStatus -> CloudAuthStatus", async () => {
    fakeRpc["CloudAuthStatus"] = () => Effect.succeed({ authenticated: true, email: "a@b.c" });
    await expect(getCloudAuthStatus()).resolves.toEqual({ authenticated: true, email: "a@b.c" });
  });

  it("startCloudAuth -> CloudAuthStart", async () => {
    const start = vi.fn(() => Effect.void);
    fakeRpc["CloudAuthStart"] = start;
    await startCloudAuth();
    expect(start).toHaveBeenCalledOnce();
  });

  it("getCloudOrgs -> CloudAuthOrgs", async () => {
    fakeRpc["CloudAuthOrgs"] = () =>
      Effect.succeed([{ id: "o1", displayName: "Org", role: "owner" }]);
    await expect(getCloudOrgs()).resolves.toHaveLength(1);
  });

  it("getCloudOrgs rejects with the main process's sentence", async () => {
    fakeRpc["CloudAuthOrgs"] = () =>
      Effect.fail(new CloudRequestError({ message: "Loading organizations failed: HTTP 502" }));
    await expect(getCloudOrgs()).rejects.toThrow("Loading organizations failed: HTTP 502");
  });

  it("getCloudWsToken names the org", async () => {
    const mint = vi.fn(() => Effect.succeed("ws-1"));
    fakeRpc["CloudWsToken"] = mint;
    await expect(getCloudWsToken("o1")).resolves.toBe("ws-1");
    expect(mint).toHaveBeenCalledWith({ orgId: "o1" });
  });
});
