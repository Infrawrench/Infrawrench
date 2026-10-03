import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";

const jsonCall = vi.fn();
vi.mock("../client-transport.js", () => ({
  jsonCall: (...a: unknown[]) => jsonCall(...a),
}));

import { getAwsLogs, formatEvent, AWS_LOG_TYPES } from "../logs.js";

const creds = { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" };

function res(fields: Record<string, unknown>, externalId = "ext"): ResourceInstance {
  return {
    id: "id",
    pluginId: "aws",
    resourceTypeId: "t",
    accountId: "acct",
    displayName: "d",
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    createdAt: "",
    updatedAt: "",
  } as ResourceInstance;
}

/** The body of the FilterLogEvents call. */
function filterBody(): Record<string, unknown> {
  const call = jsonCall.mock.calls.find((c) => c[2] === "Logs_20140328.FilterLogEvents");
  return call?.[3] as Record<string, unknown>;
}

beforeEach(() => {
  jsonCall.mockReset();
});

describe("getAwsLogs", () => {
  it("tails a Lambda function's own log group newest-last", async () => {
    jsonCall.mockResolvedValue({
      events: [
        { timestamp: 2000, message: "second\n", logStreamName: "s" },
        { timestamp: 1000, message: "first", logStreamName: "s" },
      ],
    });
    const out = await getAwsLogs(
      creds,
      res({ name: "fn", logGroup: "/custom/fn" }),
      "lambda-function",
      { tailLines: 50 },
    );
    const body = filterBody();
    expect(jsonCall.mock.calls[0]?.[1]).toBe("logs");
    expect(body["logGroupName"]).toBe("/custom/fn");
    expect(body["startFromHead"]).toBe(false);
    expect(body["limit"]).toBe(50);
    expect(out.text.split("\n")).toEqual([
      "1970-01-01T00:00:01.000Z [s] first",
      "1970-01-01T00:00:02.000Z [s] second",
    ]);
    expect(out.containers).toEqual(["function"]);
  });

  it("falls back to /aws/lambda/<name> and clamps the tail", async () => {
    jsonCall.mockResolvedValue({ events: [] });
    const out = await getAwsLogs(creds, res({ name: "fn" }), "lambda-function", {
      tailLines: 99999,
    });
    expect(filterBody()["logGroupName"]).toBe("/aws/lambda/fn");
    expect(filterBody()["limit"]).toBe(1000);
    expect(out.text).toMatch(/No log events/);
  });

  it("offers a log group's recent streams and filters to the chosen one", async () => {
    jsonCall.mockImplementation(async (_c, _s, target: string) =>
      target === "Logs_20140328.DescribeLogStreams"
        ? { logStreams: [{ logStreamName: "a" }, { logStreamName: "b" }] }
        : { events: [] },
    );
    const out = await getAwsLogs(creds, res({ logGroupName: "/g" }), "cloudwatch-log-group", {
      container: "b",
    });
    expect(out.containers).toEqual(["all streams", "a", "b"]);
    expect(out.activeContainer).toBe("b");
    expect(filterBody()["logStreamNames"]).toEqual(["b"]);
    const describe = jsonCall.mock.calls.find((c) => c[2] === "Logs_20140328.DescribeLogStreams");
    expect(describe?.[3]).toMatchObject({ orderBy: "LastEventTime", descending: true });
  });

  it("reads App Runner application or service logs", async () => {
    jsonCall.mockResolvedValue({ events: [] });
    const r = res({ serviceName: "web", serviceId: "abc123" });
    const app = await getAwsLogs(creds, r, "apprunner-service", {});
    expect(app.activeContainer).toBe("application");
    expect(filterBody()["logGroupName"]).toBe("/aws/apprunner/web/abc123/application");
    jsonCall.mockClear();
    await getAwsLogs(creds, r, "apprunner-service", { container: "service" });
    expect(filterBody()["logGroupName"]).toBe("/aws/apprunner/web/abc123/service");
  });

  it("uses a CodeBuild project's configured group and stream prefix", async () => {
    jsonCall.mockResolvedValue({ events: [] });
    await getAwsLogs(
      creds,
      res({ name: "p", _logGroupName: "/ci/builds", _logStreamPrefix: "p" }),
      "codebuild-project",
      {},
    );
    expect(filterBody()).toMatchObject({ logGroupName: "/ci/builds", logStreamNamePrefix: "p" });
    jsonCall.mockClear();
    await getAwsLogs(creds, res({ name: "p", _logGroupName: "" }), "codebuild-project", {});
    expect(filterBody()["logGroupName"]).toBe("/aws/codebuild/p");
    expect(filterBody()["logStreamNamePrefix"]).toBeUndefined();
  });

  it("splits EKS control plane logs by component, keeping audit out of api", async () => {
    jsonCall.mockResolvedValue({
      events: [
        { timestamp: 2, message: "audit", logStreamName: "kube-apiserver-audit-x" },
        { timestamp: 1, message: "api", logStreamName: "kube-apiserver-x" },
      ],
    });
    const out = await getAwsLogs(creds, res({ name: "prod" }), "eks-cluster", {
      container: "api",
    });
    expect(filterBody()).toMatchObject({
      logGroupName: "/aws/eks/prod/cluster",
      logStreamNamePrefix: "kube-apiserver-",
    });
    expect(out.text).toContain("api");
    expect(out.text).not.toContain("audit");
    expect(out.containers[0]).toBe("all components");
    expect(out.containers).toContain("controllerManager");
  });

  it("explains a missing log group instead of failing", async () => {
    jsonCall.mockRejectedValue(
      new Error('AWS logs POST / failed: 400 — {"__type":"ResourceNotFoundException"}'),
    );
    const out = await getAwsLogs(creds, res({ name: "prod" }), "eks-cluster", {});
    expect(out.text).toMatch(/Control plane logging is off/);
    expect(out.activeContainer).toBe("all components");
  });

  it("rethrows other errors and rejects unknown types", async () => {
    jsonCall.mockRejectedValue(new Error("AccessDeniedException"));
    await expect(getAwsLogs(creds, res({ name: "fn" }), "lambda-function", {})).rejects.toThrow(
      /AccessDenied/,
    );
    await expect(getAwsLogs(creds, res({}), "s3-bucket", {})).rejects.toThrow(/not supported/);
    expect(AWS_LOG_TYPES.has("s3-bucket")).toBe(false);
  });
});

describe("formatEvent", () => {
  it("omits the stream when absent", () => {
    expect(formatEvent({ timestamp: 0, message: "x" })).toBe("1970-01-01T00:00:00.000Z x");
  });
});
