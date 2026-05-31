import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const getPlugin = vi.fn();
const buildPluginHostServices = vi.fn();

vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../../plugins/loader", () => ({ getPlugin: (...args: unknown[]) => getPlugin(...args) }));
vi.mock("../sql-drivers", () => ({
  buildPluginHostServices: (...args: unknown[]) => buildPluginHostServices(...args),
}));

import { createPluginClient } from "../plugin-client";

beforeEach(() => {
  invoke.mockReset();
  getPlugin.mockReset();
  buildPluginHostServices.mockReset();
});

describe("createPluginClient", () => {
  it("fetches credentials, builds host services, and returns the plugin client", async () => {
    const credentials = { token: "t" };
    invoke.mockResolvedValue(credentials);
    const services = { http: {} };
    buildPluginHostServices.mockReturnValue(services);
    const manifest = { id: "p" };
    const client = { listResources: vi.fn() };
    const createClient = vi.fn().mockReturnValue(client);
    getPlugin.mockResolvedValue({ plugin: { manifest, createClient } });

    const result = await createPluginClient("acc-1", "p");

    expect(invoke).toHaveBeenCalledWith("account_get_credentials", { accountId: "acc-1" });
    expect(getPlugin).toHaveBeenCalledWith("p");
    expect(buildPluginHostServices).toHaveBeenCalledWith(manifest, credentials);
    expect(createClient).toHaveBeenCalledWith(credentials, services);
    expect(result).toBe(client);
  });

  it("throws when the plugin is not loaded", async () => {
    invoke.mockResolvedValue({});
    getPlugin.mockResolvedValue(undefined);
    await expect(createPluginClient("acc-1", "missing")).rejects.toThrow(/not loaded/);
  });
});
