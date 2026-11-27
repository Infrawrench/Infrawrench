/**
 * A Terraform scan as the API shows it, and a branch page's change from
 * configuration, as rules over plain values (no database).
 */
import { describe, expect, it } from "vitest";
import type { ConfigurationEstimate, TerraformScanSummary } from "@infrawrench/git-terraform";
import {
  type ScanRowView,
  estimateView,
  rootChangeView,
  rootsPlannedAtHead,
  scanView,
} from "../../terraform/scan-views";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

const root = (path: string) => ({
  path,
  reasons: ["backend" as const],
  backend: { type: "s3", settings: [{ name: "bucket", value: "state" }] },
  requiredVersion: null,
  providers: [],
  modules: [],
  localModules: [],
  resourceCount: 1,
  dataSourceCount: 0,
  resourceTypes: [{ type: "aws_instance", count: 1 }],
  variableCount: 0,
  requiredVariables: [],
  outputCount: 0,
  lockFile: false,
  tfvarsFiles: [],
  usesWorkspace: false,
  unreadable: [],
  inactiveResources: 0,
  inactiveAddresses: [],
});

const summary = (...paths: string[]): TerraformScanSummary => ({
  roots: paths.map(root),
  directories: paths.map((path) => ({ path, kind: "root" as const, moduleCalls: [] })),
  moduleCount: 0,
  truncated: false,
});

const priced = (monthly: number): ConfigurationEstimate => ({
  currency: "USD",
  monthlyTotal: monthly,
  complete: true,
  lines: [
    { address: "aws_instance.web", type: "aws_instance", count: 1, monthly, detail: "1 × t3" },
  ],
  unpriced: [],
  others: [],
});

const row = (overrides: Partial<ScanRowView> = {}): ScanRowView => ({
  commitOid: HEAD,
  summary: summary("prod"),
  estimates: null,
  pricingStatus: "pending",
  pricedAt: null,
  createdAt: new Date("2026-11-27T10:00:00Z"),
  ...overrides,
});

describe("estimateView", () => {
  it("is pending until the pass prices the scan", () => {
    expect(estimateView(row(), "prod")).toMatchObject({
      status: "pending",
      monthlyTotal: null,
      lines: [],
      pricedAt: null,
    });
  });

  it("is the stored estimate once priced", () => {
    const at = new Date("2026-11-27T11:00:00Z");
    const view = estimateView(
      row({ pricingStatus: "priced", estimates: { prod: priced(12) }, pricedAt: at }),
      "prod",
    );
    expect(view).toEqual({ status: "priced", ...priced(12), pricedAt: at.toISOString() });
  });

  it("is unavailable when nothing could price it, or the root has no estimate", () => {
    expect(estimateView(row({ pricingStatus: "unavailable" }), "prod").status).toBe("unavailable");
    expect(
      estimateView(row({ pricingStatus: "priced", estimates: { other: priced(1) } }), "prod")
        .status,
    ).toBe("unavailable");
  });
});

describe("scanView", () => {
  it("names a root's workspaces and suggests a free name", () => {
    const view = scanView(row({ summary: summary("envs/prod", "tools") }), HEAD, [
      { id: "w1", name: "envs-prod", rootPath: "envs/prod" },
    ]);
    expect(view.commitOid).toBe(HEAD);
    expect(view.scannedAt).toBe("2026-11-27T10:00:00.000Z");
    expect(view.roots.map((each) => [each.path, each.workspaces, each.suggestedWorkspace])).toEqual(
      [
        ["envs/prod", ["envs-prod"], "envs-prod-2"],
        ["tools", [], "tools"],
      ],
    );
  });

  it("reads a row written before the scanner counted inactive resources", () => {
    const old = summary("prod");
    const { inactiveResources: _count, inactiveAddresses: _addresses, ...older } = old.roots[0]!;
    const view = scanView(row({ summary: { ...old, roots: [older as never] } }), HEAD, []);
    expect(view.roots[0]).toMatchObject({ inactiveResources: 0, inactiveAddresses: [] });
  });
});

describe("rootsPlannedAtHead", () => {
  const workspaces = [
    { id: "w1", name: "prod", rootPath: "envs/prod" },
    { id: "w2", name: "staging", rootPath: "envs/staging" },
  ];
  const page = { number: 7, headOid: HEAD };

  it("is the roots a plan of this page's head has priced", () => {
    const planned = rootsPlannedAtHead(
      workspaces,
      [{ workspaceId: "w1", commitSha: HEAD, pullNumber: 7, hasPlan: true }],
      page,
    );
    expect([...planned]).toEqual(["envs/prod"]);
  });

  it("leaves a root to configuration while its plan is of another head, page, or not planned yet", () => {
    const planned = rootsPlannedAtHead(
      workspaces,
      [
        { workspaceId: "w1", commitSha: OLD, pullNumber: 7, hasPlan: true },
        { workspaceId: "w1", commitSha: HEAD, pullNumber: 8, hasPlan: true },
        { workspaceId: "w2", commitSha: HEAD, pullNumber: 7, hasPlan: false },
        { workspaceId: "gone", commitSha: HEAD, pullNumber: 7, hasPlan: true },
      ],
      page,
    );
    expect(planned.size).toBe(0);
  });
});

describe("rootChangeView", () => {
  const base = row({
    commitOid: OLD,
    pricingStatus: "priced",
    estimates: { prod: priced(10) },
  });
  const head = row({ pricingStatus: "priced", estimates: { prod: priced(25) } });

  it("is pending while either side is", () => {
    expect(rootChangeView("prod", row({ commitOid: OLD }), head, []).status).toBe("pending");
    expect(rootChangeView("prod", base, row(), []).status).toBe("pending");
  });

  it("compares the two estimates", () => {
    expect(
      rootChangeView("prod", base, head, [{ id: "w1", name: "prod", rootPath: "prod" }]),
    ).toEqual({
      path: "prod",
      workspace: "prod",
      status: "priced",
      currency: "USD",
      monthlyBefore: 10,
      monthlyAfter: 25,
      monthlyDelta: 15,
      complete: true,
      lines: [
        {
          address: "aws_instance.web",
          type: "aws_instance",
          monthlyBefore: 10,
          monthlyAfter: 25,
          monthlyDelta: 15,
        },
      ],
      unpriced: [],
    });
  });

  it("takes a root the base does not have as all added", () => {
    const change = rootChangeView("prod", row({ ...base, summary: summary() }), head, []);
    expect(change).toMatchObject({ status: "priced", monthlyBefore: 0, monthlyDelta: 25 });
    expect(rootChangeView("prod", null, head, []).monthlyDelta).toBe(25);
  });

  it("is unavailable when a side could not be priced", () => {
    expect(
      rootChangeView("prod", row({ ...base, pricingStatus: "unavailable" }), head, []).status,
    ).toBe("unavailable");
  });
});
