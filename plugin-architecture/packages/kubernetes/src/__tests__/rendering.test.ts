import { describe, expect, it } from "vitest";
import { createMockResource, runPluginRenderingTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginRenderingTests(plugin);

describe("execConsole", () => {
  const client = plugin.createClient(plugin.testCredentials);
  const typeNamed = (id: string) => plugin.resourceTypes.find((t) => t.id === id)!;

  it("is offered on pods, whose shell runs through their cluster", () => {
    const pod = createMockResource(plugin.manifest.id, typeNamed("k8s-pod"));
    expect(client.renderDetail(pod).execConsole).toBe(true);
  });

  it("is not offered on any other resource type", () => {
    for (const type of plugin.resourceTypes.filter((t) => t.id !== "k8s-pod")) {
      const resource = createMockResource(plugin.manifest.id, type);
      expect(client.renderDetail(resource).execConsole).toBeUndefined();
    }
  });
});
