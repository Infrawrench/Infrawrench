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
    const manifest = { id: "p", credentialFields: [{ key: "token", label: "Token" }] };
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

  it("connects an account behind an SSH tunnel through it", async () => {
    getCredentials.mockResolvedValue({
      connectionString: "postgresql://localhost:5432/postgres",
      password: "pw",
    });
    const tunnel = vi.fn((payload: { credentials: Record<string, string> }) => ({
      connectionString: payload.credentials["connectionString"]!.replace(
        "localhost:5432",
        "127.0.0.1:41000",
      ),
    }));
    fakeRpc["SshTunnelAccountCredentials"] = (payload: never) => Effect.sync(() => tunnel(payload));
    buildPluginHostServices.mockReturnValue({});
    const createClient = vi.fn().mockReturnValue({});
    const manifest = {
      id: "postgres",
      credentialFields: [
        { key: "connectionString", label: "Connection string", tunnel: "address" },
        { key: "password", label: "Password" },
      ],
    };
    getPlugin.mockResolvedValue({ plugin: { manifest, createClient } });

    await createPluginClient("acc-1", "postgres");

    const connected = {
      connectionString: "postgresql://127.0.0.1:41000/postgres",
      password: "pw",
    };
    expect(tunnel).toHaveBeenCalledWith({
      accountId: "acc-1",
      fields: [{ key: "connectionString", tunnel: "address" }],
      credentials: { connectionString: "postgresql://localhost:5432/postgres" },
    });
    expect(buildPluginHostServices).toHaveBeenCalledWith(manifest, connected);
    expect(createClient).toHaveBeenCalledWith(connected, {});
  });

  it("throws when the plugin is not loaded", async () => {
    getCredentials.mockResolvedValue({});
    getPlugin.mockResolvedValue(undefined);
    await expect(createPluginClient("acc-1", "missing")).rejects.toThrow(/not loaded/);
  });
});
