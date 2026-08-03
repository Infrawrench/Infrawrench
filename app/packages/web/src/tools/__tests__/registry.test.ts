import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../generic", () => ({
  genericTools: () => [
    { name: "g1", title: "G1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../connections", () => ({
  connectionTools: () => [
    { name: "c1", title: "C1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../costs", () => ({
  costTools: () => [
    { name: "k1", title: "K1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../schedules", () => ({
  scheduleTools: () => [
    { name: "sc1", title: "SC1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../rightsizing", () => ({
  rightsizingTools: () => [
    { name: "rz1", title: "RZ1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../workflows", () => ({
  workflowTools: () => [
    { name: "w1", title: "W1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../custom-graphs", () => ({
  customGraphTools: () => [
    { name: "cg1", title: "CG1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../deployments", () => ({
  deploymentTools: () => [
    { name: "d1", title: "D1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../ssh-keys", () => ({
  sshKeyTools: () => [
    { name: "s1", title: "S1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../ssh-host-keys", () => ({
  sshHostKeyTools: () => [
    { name: "h1", title: "H1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
const mockPerPlugin = vi.fn();
vi.mock("../per-plugin-create", () => ({
  perPluginCreateTools: (...a: unknown[]) => mockPerPlugin(...a),
}));

const { getToolRegistry } = await import("../registry");

describe("getToolRegistry", () => {
  beforeEach(() => {
    mockPerPlugin.mockResolvedValue([
      {
        name: "p1",
        title: "P1",
        description: "",
        inputSchema: {},
        risk: "write",
        handler: vi.fn(),
      },
    ]);
  });

  it("merges generic/connection/per-plugin tools and caches across calls", async () => {
    const tools = await getToolRegistry();
    const names = tools.map((t) => t.name);
    expect(names).toContain("g1");
    expect(names).toContain("c1");
    expect(names).toContain("k1");
    expect(names).toContain("w1");
    expect(names).toContain("cg1");
    expect(names).toContain("d1");
    expect(names).toContain("s1");
    expect(names).toContain("h1");
    expect(names).toContain("p1");

    // Second call returns the cached result without re-invoking the loader.
    const before = mockPerPlugin.mock.calls.length;
    await getToolRegistry();
    expect(mockPerPlugin.mock.calls.length).toBe(before);
  });
});
