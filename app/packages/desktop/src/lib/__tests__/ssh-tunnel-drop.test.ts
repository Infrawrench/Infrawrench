import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DraggableResource } from "../pins";

const getPlugin = vi.fn();
vi.mock("../../plugins/loader", () => ({ getPlugin: (id: string) => getPlugin(id) }));

const { sshTunnelServiceForDrop } = await import("../ssh-tunnel-drop");

function source(pluginId: string, fields: Record<string, unknown> = {}): DraggableResource {
  const base: Partial<DraggableResource> = { pluginId, fields };
  return { ...base } as DraggableResource;
}

describe("sshTunnelServiceForDrop", () => {
  beforeEach(() => {
    getPlugin.mockReset();
  });

  it("names a resource's plugin when it declares a tunnel", async () => {
    getPlugin.mockResolvedValue({ plugin: { manifest: { sshTunnel: { label: "Thing" } } } });
    await expect(sshTunnelServiceForDrop(source("thing"))).resolves.toBe("thing");
    expect(getPlugin).toHaveBeenCalledWith("thing");
  });

  it("reads a dragged account's plugin from its fields", async () => {
    getPlugin.mockResolvedValue({ plugin: { manifest: { sshTunnel: { label: "Thing" } } } });
    await expect(
      sshTunnelServiceForDrop(source("__account__", { pluginId: "thing" })),
    ).resolves.toBe("thing");
  });

  it("returns null for a plugin with no tunnel, or one that will not load", async () => {
    getPlugin.mockResolvedValue({ plugin: { manifest: {} } });
    await expect(sshTunnelServiceForDrop(source("other"))).resolves.toBeNull();
    getPlugin.mockRejectedValue(new Error("no"));
    await expect(sshTunnelServiceForDrop(source("broken"))).resolves.toBeNull();
  });
});
