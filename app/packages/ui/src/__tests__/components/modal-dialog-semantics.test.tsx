import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DEFAULT_COST_ALERT_INPUT } from "@infrawrench/client-core";
import { BudgetConfigModal } from "../../cost/BudgetConfigModal.js";
import { CostGraphConfigModal } from "../../cost/CostGraphConfigModal.js";
import { CostChangeAlertConfigModal } from "../../cost/CostChangeAlertsSection.js";
import { DEFAULT_COST_GRAPH_CONFIG } from "../../cost/config.js";
import { MetricAlertRuleModal, DEFAULT_METRIC_ALERT_INPUT } from "../../metric-alerts/index.js";
import { ScheduleEditorModal } from "../../schedules/ScheduleEditorModal.js";
import { StatusPageEditorModal } from "../../status-pages/StatusPageEditorModal.js";
import { BucketPolicyEditor } from "../../components/detail/BucketPolicyEditor.js";
import type { CostApi, CostsClient } from "../../cost/types.js";
import type { MetricAlertsClient } from "../../metric-alerts/types.js";
import type { SchedulesClient } from "../../schedules/types.js";

beforeAll(() => {
  // jsdom doesn't implement <dialog> showModal/close — stub them.
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
});

const costApi: CostApi = {
  queryCosts: vi.fn().mockResolvedValue({ series: [], totals: [] }),
  loadDimensionValues: vi.fn().mockResolvedValue([]),
  loadCostStatus: vi.fn().mockResolvedValue([]),
};

const metricAlertsClient: MetricAlertsClient = {
  listRules: vi.fn().mockResolvedValue([]),
  listEvents: vi.fn().mockResolvedValue([]),
  listMetricKeys: vi.fn().mockResolvedValue([]),
  selectorOptions: vi.fn().mockResolvedValue({ plugins: [], resourceTypes: [], tagKeys: [] }),
  previewSelector: vi.fn().mockResolvedValue(null),
};

const schedulesClient = {
  listSchedules: vi.fn().mockResolvedValue([]),
  previewSchedule: vi.fn().mockResolvedValue(null),
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
} as unknown as SchedulesClient;

const costsClient = {
  ...costApi,
  listAlerts: vi.fn().mockResolvedValue([]),
  listAlertEvents: vi.fn().mockResolvedValue([]),
} as unknown as CostsClient;

/**
 * Every one of these used to be a `fixed inset-0` overlay `<div>`: no focus
 * trap, no Escape, and a backdrop the assistive tree still walked into. The
 * shared `Modal` primitive gets all three from the native element, so the
 * regression these guard against is someone hand-rolling an overlay again.
 */
describe("converted modals render a native <dialog>", () => {
  const cases: { name: string; ariaLabel: string; render: () => void }[] = [
    {
      name: "BudgetConfigModal",
      ariaLabel: "Budget",
      render: () =>
        void render(
          <BudgetConfigModal
            initialInput={{
              name: "",
              amountCents: 10_000,
              currency: "USD",
              thresholds: [],
              filters: [],
            }}
            api={costApi}
            onSave={vi.fn()}
            onClose={vi.fn()}
          />,
        ),
    },
    {
      name: "CostGraphConfigModal",
      ariaLabel: "Cost graph",
      render: () =>
        void render(
          <CostGraphConfigModal
            initialConfig={DEFAULT_COST_GRAPH_CONFIG}
            initialTitle=""
            api={costApi}
            onSave={vi.fn()}
            onClose={vi.fn()}
          />,
        ),
    },
    {
      name: "CostChangeAlertConfigModal",
      ariaLabel: "Change alert",
      render: () =>
        void render(
          <CostChangeAlertConfigModal
            client={costsClient}
            initialInput={DEFAULT_COST_ALERT_INPUT}
            onSave={vi.fn()}
            onClose={vi.fn()}
          />,
        ),
    },
    {
      name: "MetricAlertRuleModal",
      ariaLabel: "Metric alert rule",
      render: () =>
        void render(
          <MetricAlertRuleModal
            initialInput={DEFAULT_METRIC_ALERT_INPUT}
            client={metricAlertsClient}
            onSave={vi.fn()}
            onClose={vi.fn()}
          />,
        ),
    },
    {
      name: "ScheduleEditorModal",
      ariaLabel: "New sleep schedule",
      render: () =>
        void render(
          <ScheduleEditorModal
            client={schedulesClient}
            target={{ resourceId: "r1", accountId: "a1", resourceName: "web-1" }}
            existing={null}
            onSaved={vi.fn()}
            onClose={vi.fn()}
          />,
        ),
    },
    {
      name: "StatusPageEditorModal",
      ariaLabel: "New status page",
      render: () =>
        void render(
          <StatusPageEditorModal
            page={null}
            probes={[{ id: "p1", name: "api" }]}
            onCancel={vi.fn()}
            onSave={vi.fn()}
          />,
        ),
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} is a <dialog> named "${testCase.ariaLabel}"`, () => {
      testCase.render();
      const dialog = document.querySelector("dialog");
      expect(dialog).not.toBeNull();
      // A named dialog is the whole point of the conversion: without it a
      // screen reader announces "dialog" and nothing else.
      expect(dialog).toHaveAttribute("aria-label", testCase.ariaLabel);
      expect(dialog!.open).toBe(true);
    });
  }
});

describe("BucketPolicyEditor template picker", () => {
  it("opens as a named <dialog> with a labelled close button", async () => {
    render(
      <BucketPolicyEditor
        capability={{
          bucketArn: "arn:aws:s3:::my-bucket",
          bucketName: "my-bucket",
          vendor: "aws-s3",
        }}
        onGetManifest={() =>
          Promise.resolve(JSON.stringify({ Version: "2012-10-17", Statement: [] }))
        }
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "+ From template…" }));

    await waitFor(() => {
      const dialog = document.querySelector("dialog");
      expect(dialog).not.toBeNull();
      expect(dialog).toHaveAttribute("aria-label", "Choose a policy template");
    });
    // The close control used to be a bare "✕", which reads as "multiplication
    // sign" or is skipped entirely.
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});

describe("StatusPageEditorModal accessible names", () => {
  it("labels the probe picker and the per-component text inputs", () => {
    render(
      <StatusPageEditorModal
        page={{
          id: "sp1",
          title: "Acme",
          description: null,
          supportUrl: null,
          showHistory: true,
          showUptime: true,
          published: false,
          slug: "acme",
          customHostname: null,
          customHostnameStatus: "none",
          customHostnameError: null,
          customHostnameVerification: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          components: [
            {
              id: "c1",
              probeId: "p1",
              probeName: "api",
              label: null,
              groupName: null,
              position: 0,
              probeStatus: "up",
              probeEnabled: true,
            },
          ],
        }}
        probes={[
          { id: "p1", name: "api" },
          { id: "p2", name: "web" },
        ]}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Add a probe" })).toBeInTheDocument();
    // Placeholders vanish the moment somebody types; these need real labels.
    expect(screen.getByLabelText("Public name")).toBeInTheDocument();
    expect(screen.getByLabelText("Group")).toBeInTheDocument();
  });
});
