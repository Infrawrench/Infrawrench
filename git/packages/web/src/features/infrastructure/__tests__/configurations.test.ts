// @vitest-environment node
import { describe, expect, it } from "vitest";
import type {
  TerraformConfigurationEstimate,
  TerraformRoot,
  TerraformScan,
} from "@infrawrench/git-contract";
import {
  changePending,
  estimateFigure,
  inactiveTitle,
  infrastructureView,
  migrationCommand,
  othersByKind,
  rootLabel,
  scanPending,
  setupWorkspaceName,
  stateLocation,
} from "../configurations";

const estimate = (
  over: Partial<TerraformConfigurationEstimate> = {},
): TerraformConfigurationEstimate => ({
  status: "priced",
  currency: "USD",
  monthlyTotal: 49.06,
  complete: true,
  lines: [],
  unpriced: [],
  others: [],
  pricedAt: null,
  ...over,
});

const root = (path: string, workspaces: string[] = [], over: Partial<TerraformRoot> = {}) =>
  ({
    path,
    workspaces,
    suggestedWorkspace: path.split("/").join("-") || "default",
    backend: null,
    estimate: estimate(),
    ...over,
  }) as TerraformRoot;

const scan = (roots: TerraformRoot[]): Pick<TerraformScan, "roots"> => ({ roots });

describe("infrastructureView", () => {
  it("waits for the scan before saying there is nothing", () => {
    expect(infrastructureView(0, undefined, false)).toBe("loading");
  });

  it("says none found when there are no workspaces and no roots", () => {
    expect(infrastructureView(0, scan([]), true)).toBe("empty");
    // A scan that failed is settled too, and shows no roots.
    expect(infrastructureView(0, undefined, true)).toBe("empty");
  });

  it("shows the detected configurations when there are no workspaces", () => {
    expect(infrastructureView(0, scan([root("infra/terraform")]), true)).toBe("configurations");
  });

  it("tells workspaces alone from workspaces beside roots without one", () => {
    expect(infrastructureView(1, scan([root("prod", ["prod"])]), true)).toBe("workspaces");
    expect(infrastructureView(1, scan([root("prod", ["prod"]), root("bootstrap")]), true)).toBe(
      "mixed",
    );
    // Workspaces show at once, whatever the scan is doing.
    expect(infrastructureView(2, undefined, false)).toBe("workspaces");
  });
});

describe("estimateFigure", () => {
  it("never shows a number it does not have", () => {
    expect(estimateFigure(estimate({ status: "pending", monthlyTotal: null }))).toBe("Estimating");
    expect(estimateFigure(estimate({ status: "unavailable", monthlyTotal: null }))).toBe(
      "Not priced",
    );
    expect(
      estimateFigure(
        estimate({
          monthlyTotal: null,
          currency: null,
          unpriced: [{ address: "aws_nat_gateway.a", type: "aws_nat_gateway", reason: "x" }],
        }),
      ),
    ).toBe("Not priced");
    expect(estimateFigure(estimate({ monthlyTotal: null, currency: null }))).toBe("Nothing priced");
  });

  it("formats a priced total", () => {
    expect(estimateFigure(estimate())).toBe("$49.06");
  });
});

describe("polling", () => {
  it("asks again only while an estimate is pending", () => {
    expect(scanPending(undefined)).toBe(false);
    expect(scanPending(scan([root("a")]))).toBe(false);
    expect(
      scanPending(scan([root("a"), root("b", [], { estimate: estimate({ status: "pending" }) })])),
    ).toBe(true);
    expect(changePending({ roots: [] })).toBe(false);
    expect(
      changePending({ roots: [{ status: "pending" } as never, { status: "priced" } as never] }),
    ).toBe(true);
  });
});

describe("othersByKind", () => {
  it("groups by kind in a fixed order, most first, and drops empty kinds", () => {
    expect(
      othersByKind([
        { type: "aws_iam_role", count: 4, kind: "free" },
        { type: "aws_s3_bucket", count: 1, kind: "usage" },
        { type: "aws_lambda_function", count: 2, kind: "usage" },
      ]),
    ).toEqual([
      { kind: "usage", total: 3, types: ["aws_lambda_function × 2", "aws_s3_bucket"] },
      { kind: "free", total: 4, types: ["aws_iam_role × 4"] },
    ]);
  });
});

describe("moving a root's state", () => {
  it("migrates from local state or another backend, and reconfigures one already here", () => {
    expect(migrationCommand(root("a"))).toBe("terraform init -migrate-state");
    expect(migrationCommand(root("a", [], { backend: { type: "s3", settings: [] } }))).toBe(
      "terraform init -migrate-state",
    );
    expect(migrationCommand(root("a", [], { backend: { type: "http", settings: [] } }))).toBe(
      "terraform init -reconfigure",
    );
  });

  it("says where the state is now", () => {
    expect(stateLocation(root("a"))).toBe("Local state");
    expect(
      stateLocation(
        root("a", [], {
          backend: { type: "s3", settings: [{ name: "bucket", value: "acme-state" }] },
        }),
      ),
    ).toBe("s3 · acme-state");
    expect(stateLocation(root("a", [], { backend: { type: "gcs", settings: [] } }))).toBe("gcs");
    expect(
      stateLocation(
        root("a", [], {
          backend: {
            type: "http",
            settings: [
              { name: "address", value: "https://git.example/acme/infra/terraform/p/state" },
            ],
          },
        }),
      ),
    ).toBe("http · git.example");
  });

  it("uses an existing workspace's name, else the suggestion", () => {
    expect(setupWorkspaceName(root("infra/terraform"))).toBe("infra-terraform");
    expect(setupWorkspaceName(root("infra/terraform", ["prod"]))).toBe("prod");
  });
});

describe("labels", () => {
  it("names the repository's top and what default values switch off", () => {
    expect(rootLabel("")).toBe("/");
    expect(rootLabel("infra/terraform")).toBe("infra/terraform");
    expect(inactiveTitle(62)).toBe("62 switched off by default values");
  });
});
