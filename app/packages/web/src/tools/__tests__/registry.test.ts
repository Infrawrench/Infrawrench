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
// Every tool module is stubbed, not just for isolation: each one imports the
// services it wraps, which import `db/client`, which throws at import time
// without DATABASE_URL. A module added to the registry and missed here fails
// the whole file at collection rather than at an assertion.
vi.mock("../cost-anomaly-feedback", () => ({
  costAnomalyFeedbackTools: () => [
    { name: "af1", title: "AF1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../unit-costs", () => ({
  unitCostTools: () => [
    { name: "u1", title: "U1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../cost-reports", () => ({
  costReportTools: () => [
    { name: "cr1", title: "CR1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../cost-canvases", () => ({
  costCanvasTools: () => [
    { name: "cv1", title: "CV1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../cost-alerts", () => ({
  costAlertTools: () => [
    { name: "ca1", title: "CA1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../invoices", () => ({
  invoiceTools: () => [
    { name: "iv1", title: "IV1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
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
vi.mock("../github-issues", () => ({
  githubIssueTools: () => [
    { name: "gh1", title: "GH1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../savings", () => ({
  savingsTools: () => [
    { name: "sv1", title: "SV1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../carbon", () => ({
  carbonTools: () => [
    { name: "cb1", title: "CB1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../price-catalog", () => ({
  priceCatalogTools: () => [
    { name: "pc1", title: "PC1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../ai-attribution", () => ({
  aiAttributionTools: () => [
    { name: "ai1", title: "AI1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../network-costs", () => ({
  networkCostTools: () => [
    { name: "nc1", title: "NC1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../moment", () => ({
  momentTools: () => [
    { name: "m1", title: "M1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
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
vi.mock("../virtual-tags", () => ({
  virtualTagTools: () => [
    { name: "vt1", title: "VT1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
  ],
}));
vi.mock("../linux-apps", () => ({
  linuxAppTools: () => [
    { name: "la1", title: "LA1", description: "", inputSchema: {}, risk: "read", handler: vi.fn() },
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
    expect(names).toContain("u1");
    expect(names).toContain("cr1");
    expect(names).toContain("cv1");
    expect(names).toContain("ca1");
    expect(names).toContain("iv1");
    expect(names).toContain("m1");
    expect(names).toContain("cb1");
    expect(names).toContain("pc1");
    expect(names).toContain("gh1");
    expect(names).toContain("sv1");
    expect(names).toContain("ai1");
    expect(names).toContain("w1");
    expect(names).toContain("cg1");
    expect(names).toContain("d1");
    expect(names).toContain("s1");
    expect(names).toContain("h1");
    expect(names).toContain("la1");
    expect(names).toContain("p1");

    // Second call returns the cached result without re-invoking the loader.
    const before = mockPerPlugin.mock.calls.length;
    await getToolRegistry();
    expect(mockPerPlugin.mock.calls.length).toBe(before);
  });
});
