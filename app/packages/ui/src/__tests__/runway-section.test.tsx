import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { RunwayListResponse, RunwayRow } from "@infrawrench/client-core";

import { RunwaySection } from "../quotas/RunwaySection.js";

const GiB = 1024 ** 3;

function row(overrides: Partial<RunwayRow>): RunwayRow {
  return {
    key: "usedBytes",
    resourceId: "fly:a1:vol-1",
    resourceName: "pg-data",
    resourceTypeId: "volume",
    accountId: "a1",
    accountName: "prod",
    pluginId: "fly",
    label: "Storage",
    unit: "bytes",
    used: 9 * GiB,
    limit: 10 * GiB,
    utilization: 0.9,
    limitSource: "provider",
    plan: null,
    kind: "runway",
    source: "field",
    observedAt: "2026-11-18T12:00:00.000Z",
    forecast: {
      perDay: GiB / 5,
      daysLeft: 5,
      fullAt: "2026-11-23T12:00:00.000Z",
      method: "trend",
      confidence: "ok",
      points: 120,
    },
    cycle: null,
    status: "critical",
    ...overrides,
  };
}

const DATA: RunwayListResponse = {
  rows: [
    row({}),
    row({
      key: "emails",
      resourceId: "mailgun:a2:acct",
      resourceName: "mail",
      label: "Emails sent",
      unit: "emails",
      used: 1_000,
      limit: 50_000,
      utilization: 0.02,
      limitSource: "plan",
      plan: "Foundation",
      kind: "allowance",
      forecast: {
        perDay: null,
        daysLeft: null,
        fullAt: null,
        method: null,
        confidence: "short",
        points: 1,
      },
      cycle: {
        start: "2026-11-01T00:00:00.000Z",
        end: "2026-12-01T00:00:00.000Z",
        projectedUsed: null,
        projectedUtilization: null,
      },
      status: "ok",
    }),
  ],
  runwayDays: 14,
  allowanceThreshold: 0.8,
  windowDays: 14,
};

describe("RunwaySection", () => {
  it("lists usages with their amounts, limit source and countdown", () => {
    render(<RunwaySection data={DATA} />);
    expect(screen.getByText("pg-data")).toBeTruthy();
    expect(screen.getByText("5 days")).toBeTruthy();
    expect(screen.getByText("Foundation plan")).toBeTruthy();
    expect(screen.getByText("no trend yet")).toBeTruthy();
  });

  it("filters to rows at risk and opens a resource", () => {
    const onOpenResource = vi.fn();
    render(<RunwaySection data={DATA} onOpenResource={onOpenResource} />);
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.queryByText("mail")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "pg-data" }));
    expect(onOpenResource).toHaveBeenCalledWith(DATA.rows[0]);
  });

  it("says when nothing is tracked", () => {
    render(<RunwaySection data={{ ...DATA, rows: [] }} />);
    expect(screen.getByText("No resources with a tracked usage and limit yet.")).toBeTruthy();
  });
});
