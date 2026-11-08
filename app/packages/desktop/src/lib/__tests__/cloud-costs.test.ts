/**
 * The cost wrappers (`../cloud-costs.ts`) over the cloud transport, against a
 * fake `CloudHttp`: what each call sends, and what the panel gets back. The
 * cases are the ones where a wrapper does more than hand the call on: the
 * envelopes it unwraps, the query it builds, the defaults it fills in, the
 * fields it leaves out, and the call it composes from two.
 */
import type { CostQueryRequest } from "@infrawrench/ui/cost";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);
vi.mock("../rpc/desktop-client", async () => (await import("./fake-rpc")).fakeRpcClientModule);

const { answerCloudHttp, resetFakeRpc } = await import("./fake-rpc");
const costs = await import("../cloud-costs");

const ORG = "org-1";

beforeEach(() => {
  resetFakeRpc();
});

describe("cost queries", () => {
  it("posts the query and hands back the response", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { series: [] } }));
    const request: CostQueryRequest = {
      from: "2026-10-01",
      to: "2026-10-31",
      binning: "daily",
      groupBy: "service",
      groupByTagKey: undefined,
      filters: [],
      topN: 5,
      comparePreviousPeriod: false,
      forecast: false,
    };

    await expect(costs.queryCloudCosts(ORG, request)).resolves.toEqual({ series: [] });
    expect(http).toHaveBeenCalledWith({
      method: "POST",
      url: "/api/org/org-1/costs/query",
      // The `undefined` key is left out, as JSON.stringify did over IPC.
      body: JSON.stringify({
        from: "2026-10-01",
        to: "2026-10-31",
        binning: "daily",
        groupBy: "service",
        filters: [],
        topN: 5,
        comparePreviousPeriod: false,
        forecast: false,
      }),
    });
  });

  it("reads a dimension's values, naming plain strings as options", async () => {
    const http = answerCloudHttp(() => ({
      status: 200,
      json: { values: ["prod", { value: "dev", label: "Development" }] },
    }));

    await expect(costs.loadCloudCostDimensionValues(ORG, "tag", "env")).resolves.toEqual([
      { value: "prod", label: "prod" },
      { value: "dev", label: "Development" },
    ]);
    expect(http).toHaveBeenCalledWith({
      method: "GET",
      url: "/api/org/org-1/costs/dimensions?dimension=tag&tagKey=env",
    });
  });

  it("unwraps the anomaly list over a 30-day window by default", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { anomalies: [{ id: "a1" }] } }));

    await expect(costs.listCloudCostAnomalies(ORG)).resolves.toEqual([{ id: "a1" }]);
    expect(http).toHaveBeenCalledWith({
      method: "GET",
      url: "/api/org/org-1/costs/anomalies?days=30",
    });
  });

  it("asks for the efficiency alerts of one kind", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { events: [] } }));

    await costs.loadCloudEfficiencyAlerts(ORG, { kind: "commitment_idle", limit: 20 });
    expect(http).toHaveBeenCalledWith({
      method: "GET",
      url: "/api/org/org-1/costs/efficiency-alerts?kind=commitment_idle&limit=20",
    });
  });
});

describe("cost reports", () => {
  it("fills in the config keys the contract defaults when it decodes", async () => {
    const http = answerCloudHttp(() => ({
      status: 200,
      json: [
        {
          id: "r1",
          name: "Spend",
          config: { version: 1, chartType: "line", groupBy: "none" },
        },
      ],
    }));

    const [report] = await costs.listCloudCostReports(ORG);
    expect(report?.config).toEqual({
      version: 1,
      chartType: "line",
      groupBy: "none",
      filters: [],
      topN: 5,
      comparePreviousPeriod: false,
      showForecast: false,
    });
    expect(http).toHaveBeenCalledWith({ method: "GET", url: "/api/org/org-1/cost-reports" });
  });

  it("keeps the config the server sent", async () => {
    answerCloudHttp(() => ({
      status: 200,
      json: {
        id: "r1",
        config: { filters: [{ dimension: "provider" }], topN: 10, comparePreviousPeriod: true },
      },
    }));

    const report = await costs.getCloudCostReport(ORG, "r1");
    expect(report.config).toMatchObject({
      filters: [{ dimension: "provider" }],
      topN: 10,
      comparePreviousPeriod: true,
      showForecast: false,
    });
  });

  it("unwraps a report's forecasts", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { forecasts: [{ id: "f1" }] } }));

    await expect(costs.listCloudCostForecasts(ORG, "r 1")).resolves.toEqual([{ id: "f1" }]);
    expect(http).toHaveBeenCalledWith({
      method: "GET",
      url: "/api/org/org-1/cost-reports/r%201/forecasts",
    });
  });

  it("shows the server's refusal to delete a referenced filter", async () => {
    answerCloudHttp(() => ({ status: 409, json: { error: "Used by 2 reports" } }));

    await expect(costs.deleteCloudSavedCostFilter(ORG, "f1")).rejects.toThrow(
      'Cloud request failed: 409 /saved-cost-filters/f1 {"error":"Used by 2 reports"}',
    );
  });
});

describe("scenario models", () => {
  it("fills in the adjustment fields the contract defaults to null", async () => {
    answerCloudHttp(() => ({
      status: 200,
      json: {
        models: [
          {
            id: "m1",
            adjustments: [
              { id: "a1", label: "GCP commit", kind: "one_off", startDate: "2027-01-01" },
            ],
          },
        ],
      },
    }));

    const [model] = await costs.listCloudCostScenarioModels(ORG);
    expect(model?.adjustments).toEqual([
      {
        id: "a1",
        label: "GCP commit",
        kind: "one_off",
        startDate: "2027-01-01",
        endDate: null,
        amountCents: null,
        currency: null,
        period: null,
        percent: null,
        scope: [],
      },
    ]);
  });
});

describe("network flow settings", () => {
  it("keeps the stored lookback when the toggle names none", async () => {
    const http = answerCloudHttp((request) =>
      request.method === "GET"
        ? { status: 200, json: { enabled: false, initialLookbackDays: 14 } }
        : { status: 200, json: { enabled: true, initialLookbackDays: 14 } },
    );

    await expect(costs.saveCloudNetworkFlowSettings(ORG, { enabled: true })).resolves.toEqual({
      enabled: true,
      initialLookbackDays: 14,
    });
    expect(http.mock.calls.map(([request]) => request)).toEqual([
      { method: "GET", url: "/api/org/org-1/network-flows/settings" },
      {
        method: "PUT",
        url: "/api/org/org-1/network-flows/settings",
        body: JSON.stringify({ enabled: true, initialLookbackDays: 14 }),
      },
    ]);
  });

  it("sends a named lookback in one call", async () => {
    const http = answerCloudHttp(() => ({
      status: 200,
      json: { enabled: true, initialLookbackDays: 7 },
    }));

    await costs.saveCloudNetworkFlowSettings(ORG, { enabled: true, initialLookbackDays: 7 });
    expect(http).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledWith({
      method: "PUT",
      url: "/api/org/org-1/network-flows/settings",
      body: JSON.stringify({ enabled: true, initialLookbackDays: 7 }),
    });
  });
});

describe("dashboard widgets", () => {
  it("adds a card, leaving an absent title out", async () => {
    const http = answerCloudHttp(() => ({ status: 201, json: { id: "w1" } }));

    await costs.createCloudWidget(ORG, {
      dashboardId: "d1",
      kind: "budget",
      config: { version: 1, budgetId: "b1" },
    });
    expect(http).toHaveBeenCalledWith({
      method: "POST",
      url: "/api/org/org-1/dashboards/widgets",
      body: JSON.stringify({
        dashboardId: "d1",
        kind: "budget",
        config: { version: 1, budgetId: "b1" },
      }),
    });
  });

  it("refuses a config that is not an object without sending it", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: {} }));

    await expect(costs.updateCloudWidget(ORG, "w1", { config: "nope" })).rejects.toThrow(
      "A widget config must be a JSON object",
    );
    expect(http).not.toHaveBeenCalled();
  });

  it("evaluates a KPI card's config", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { value: 1 } }));
    const config = {
      version: 1,
      source: { kind: "commitments", measure: "coverage" },
      comparePreviousPeriod: true,
    } as const;

    await costs.evaluateCloudDashboardKpi(ORG, config);
    expect(http).toHaveBeenCalledWith({
      method: "POST",
      url: "/api/org/org-1/dashboards/kpi",
      body: JSON.stringify({ config }),
    });
  });
});

describe("realized savings", () => {
  it("searches the spotlight index for resources only", async () => {
    const http = answerCloudHttp(() => ({
      status: 200,
      json: [
        { id: "r1", pluginId: "aws" },
        { id: "w1", pluginId: "__workflows__" },
      ],
    }));

    await expect(costs.searchCloudSavingsResources(ORG, "web app")).resolves.toEqual([
      { id: "r1", pluginId: "aws" },
    ]);
    expect(http).toHaveBeenCalledWith({ method: "GET", url: "/api/org/org-1/search?q=web+app" });
  });

  it("reads the report for a range", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { events: [] } }));

    await costs.loadCloudRealizedSavings(ORG, { from: "2026-01-01" });
    expect(http).toHaveBeenCalledWith({
      method: "GET",
      url: "/api/org/org-1/savings/realized?from=2026-01-01",
    });
  });
});

describe("business metrics", () => {
  it("reads the last 90 values by default", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { values: [{ date: "d" }] } }));

    await expect(costs.listCloudBusinessMetricValues(ORG, "m1")).resolves.toEqual([{ date: "d" }]);
    expect(http).toHaveBeenCalledWith({
      method: "GET",
      url: "/api/org/org-1/business-metrics/m1/values?limit=90",
    });
  });

  it("answers null for a metric with no importer", async () => {
    answerCloudHttp(() => ({ status: 200, json: { importer: null } }));

    await expect(costs.getCloudBusinessMetricImporter(ORG, "m1")).resolves.toBeNull();
  });

  it("runs an importer with an empty request by default", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { id: "run1" } }));

    await costs.runCloudBusinessMetricImporter(ORG, "m1");
    expect(http).toHaveBeenCalledWith({
      method: "POST",
      url: "/api/org/org-1/business-metrics/m1/importer/run",
      body: "{}",
    });
  });
});

describe("anomaly feedback", () => {
  it("deletes a suppression and resolves with nothing", async () => {
    const http = answerCloudHttp(() => ({ status: 204 }));

    await expect(costs.deleteCloudAnomalySuppression(ORG, "s1")).resolves.toBeUndefined();
    expect(http).toHaveBeenCalledWith({
      method: "DELETE",
      url: "/api/org/org-1/costs/anomaly-suppressions/s1",
    });
  });
});
