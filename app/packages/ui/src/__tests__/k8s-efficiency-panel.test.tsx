import { describe, expect, it, vi, beforeAll } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  buildKubernetesEfficiencyResult,
  DEFAULT_K8S_EFFICIENCY_CONFIG,
  type KubernetesEfficiencyReport,
} from "@infrawrench/client-core";
import { KubernetesEfficiencyPanel } from "../k8s-efficiency/KubernetesEfficiencyPanel.js";
import type { KubernetesEfficiencyClient } from "../k8s-efficiency/types.js";
import { kubernetesEfficiencyReportInputSchema } from "../cost/config.js";

beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
  }
  // recharts measures its container; jsdom has no layout.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const report: KubernetesEfficiencyReport = {
  id: "r1",
  name: "Platform efficiency",
  description: null,
  config: DEFAULT_K8S_EFFICIENCY_CONFIG,
  folderId: null,
  createdByUserId: "u1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const result = buildKubernetesEfficiencyResult(
  [
    {
      bucket: "2026-10-01",
      group: "payments",
      accountId: "c1",
      service: "kubernetes-workload",
      resource: "cpu",
      usage: "used",
      currency: "USD",
      amount: 30,
    },
    {
      bucket: "2026-10-01",
      group: "payments",
      accountId: "c1",
      service: "kubernetes-workload",
      resource: "cpu",
      usage: "unused",
      currency: "USD",
      amount: 10,
    },
    {
      bucket: "2026-10-01",
      group: "",
      accountId: "c1",
      service: "kubernetes-idle",
      resource: "cpu",
      usage: "idle",
      currency: "USD",
      amount: 10,
    },
  ],
  { config: DEFAULT_K8S_EFFICIENCY_CONFIG, from: "2026-10-01", to: "2026-10-01" },
);

function makeClient(
  overrides: Partial<KubernetesEfficiencyClient> = {},
): KubernetesEfficiencyClient {
  return {
    listReports: vi.fn(async () => [report]),
    getReport: vi.fn(async () => report),
    runReport: vi.fn(async () => ({ reportId: "r1", name: report.name, result })),
    query: vi.fn(async () => result),
    getOptions: vi.fn(async () => ({
      clusters: [{ id: "c1", name: "prod" }],
      regions: [],
      namespaces: ["payments"],
      nodePools: [],
      labelKeys: [],
    })),
    getTagValues: vi.fn(async () => []),
    ...overrides,
  };
}

describe("KubernetesEfficiencyPanel", () => {
  it("lists reports and opens one", async () => {
    const onSelect = vi.fn();
    render(<KubernetesEfficiencyPanel client={makeClient()} onSelectReport={onSelect} />);
    fireEvent.click(await screen.findByText("Platform efficiency"));
    expect(onSelect).toHaveBeenCalledWith("r1");
  });

  it("renders a report: groups, the idle row and the efficiency", async () => {
    render(<KubernetesEfficiencyPanel client={makeClient()} reportId="r1" />);
    expect(await screen.findByRole("button", { name: "payments" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Idle capacity" })).toBeTruthy();
    // payments: 30 used of 40 measured.
    expect(screen.getAllByText("75%").length).toBeGreaterThan(0);
    // Total: 30 used of 50 measured.
    expect(screen.getAllByText("60%").length).toBeGreaterThan(0);
  });

  it("re-runs with a view-only category filter rather than saving it", async () => {
    const client = makeClient({ updateReport: vi.fn() });
    render(<KubernetesEfficiencyPanel client={client} reportId="r1" />);
    await screen.findByRole("button", { name: "payments" });
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Memory" })[0]!);
    await waitFor(() =>
      expect(client.query).toHaveBeenCalledWith(
        expect.objectContaining({ categories: ["memory"] }),
      ),
    );
    expect(client.updateReport).not.toHaveBeenCalled();
  });

  it("offers no write actions to a read-only host", async () => {
    render(<KubernetesEfficiencyPanel client={makeClient()} />);
    await screen.findByText("Platform efficiency");
    expect(screen.queryByRole("button", { name: "New report" })).toBeNull();
  });
});

describe("kubernetesEfficiencyReportInputSchema", () => {
  it("accepts the default config and refuses a label grouping without a key", () => {
    expect(
      kubernetesEfficiencyReportInputSchema.safeParse({
        name: "x",
        config: DEFAULT_K8S_EFFICIENCY_CONFIG,
      }).success,
    ).toBe(true);
    expect(
      kubernetesEfficiencyReportInputSchema.safeParse({
        name: "x",
        config: { ...DEFAULT_K8S_EFFICIENCY_CONFIG, groupBy: "label" },
      }).success,
    ).toBe(false);
  });
});
