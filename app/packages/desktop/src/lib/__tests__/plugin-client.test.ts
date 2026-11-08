import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

const getCredentials = vi.fn();
const getPlugin = vi.fn();
const buildPluginHostServices = vi.fn();

vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);
vi.mock("../../plugins/loader", () => ({ getPlugin: (...args: unknown[]) => getPlugin(...args) }));
vi.mock("../sql-drivers", () => ({
  buildPluginHostServices: (...args: unknown[]) => buildPluginHostServices(...args),
}));

import { createPluginClient } from "../plugin-client";
import { fakeRpc, resetFakeRpc } from "./fake-rpc";

beforeEach(() => {
  resetFakeRpc();
  getCredentials.mockReset();
  fakeRpc["LocalAccountCredentials"] = (payload: unknown) =>
    Effect.promise(() => Promise.resolve(getCredentials(payload)));
  getPlugin.mockReset();
  buildPluginHostServices.mockReset();
});

describe("createPluginClient", () => {
  it("fetches credentials, builds host services, and returns the plugin client", async () => {
    const credentials = { token: "t" };
    getCredentials.mockResolvedValue(credentials);
    const services = { http: {} };
    buildPluginHostServices.mockReturnValue(services);
    const manifest = { id: "p" };
    const client = { listResources: vi.fn() };
    const createClient = vi.fn().mockReturnValue(client);
    getPlugin.mockResolvedValue({ plugin: { manifest, createClient } });

    const result = await createPluginClient("acc-1", "p");

    expect(getCredentials).toHaveBeenCalledWith({ accountId: "acc-1" });
    expect(getPlugin).toHaveBeenCalledWith("p");
    expect(buildPluginHostServices).toHaveBeenCalledWith(manifest, credentials);
    expect(createClient).toHaveBeenCalledWith(credentials, services);
    expect(result).toBe(client);
  });

  it("throws when the plugin is not loaded", async () => {
    getCredentials.mockResolvedValue({});
    getPlugin.mockResolvedValue(undefined);
    await expect(createPluginClient("acc-1", "missing")).rejects.toThrow(/not loaded/);
  });
});
