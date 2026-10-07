import { describe, expect, it } from "vitest";
import { exportResourcesToTerraform } from "@infrawrench/plugin-base";
import { normalizeRealm, statusOf } from "../api.js";
import { parseMutingFilters, reconcileRules, SplunkObservabilityClient } from "../client.js";
import { detectLabels, mapDetector } from "../mappers.js";
import { decodeSignalFlow, resolutionFor } from "../signalflow.js";
import { verifySplunkCredentials } from "../preflight.js";
import { splunkTerraformExport } from "../terraform.js";
import { CREDS, makeHttp } from "./helpers.js";

describe("realm", () => {
  it("accepts an id or a pasted app URL", () => {
    expect(normalizeRealm("EU0")).toBe("eu0");
    expect(normalizeRealm("https://app.jp0.observability.splunkcloud.com/#/home")).toBe("jp0");
  });
});

describe("SplunkObservabilityClient", () => {
  it("pages detectors with limit/offset and sends X-SF-Token", async () => {
    const page = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `D${from + i}`,
        name: `d${from + i}`,
        rules: [],
      }));
    const { http, calls } = makeHttp((url) => {
      if (url.pathname === "/v2/detector") {
        const offset = Number(url.searchParams.get("offset"));
        return { body: { count: 1001, results: offset === 0 ? page(1000, 0) : page(1, 1000) } };
      }
      return undefined;
    });
    const client = new SplunkObservabilityClient(CREDS, { http });
    const list = await client.listResources("detector", "acct");
    expect(list).toHaveLength(1001);
    expect(calls[0]?.url.origin).toBe("https://api.us1.observability.splunkcloud.com");
    expect(calls[0]?.headers["X-SF-Token"]).toBe("sf-token");
    expect(calls[1]?.url.searchParams.get("offset")).toBe("1000");
  });

  it("maps errors to a status and lists a 403'd type empty", async () => {
    const { http } = makeHttp((url) =>
      url.pathname === "/v2/token"
        ? { status: 403, body: { code: 403, message: "admin only" } }
        : { status: 500, body: { message: "boom" } },
    );
    const client = new SplunkObservabilityClient(CREDS, { http });
    expect(await client.listResources("org-token", "acct")).toEqual([]);
    const err = await client.listResources("team", "acct").catch((e: unknown) => e);
    expect(statusOf(err)).toBe(500);
    expect(String(err)).toContain("boom");
  });

  it("turns every detector rule off by label", async () => {
    const { http, calls } = makeHttp((url, method) => {
      if (url.pathname === "/v2/detector/D1" && method === "GET") {
        return { body: { id: "D1", rules: [{ detectLabel: "a" }, { detectLabel: "b" }] } };
      }
      if (url.pathname === "/v2/detector/D1/disable") return { status: 204 };
      return undefined;
    });
    await new SplunkObservabilityClient(CREDS, { http }).invokeAction(
      "detector",
      "acct:detector:D1",
      "disable",
      "acct",
    );
    expect(calls[1]?.body).toEqual(["a", "b"]);
  });

  it("rotates a token and never keeps the secret on update", async () => {
    const { http, calls } = makeHttp((url, method) => {
      if (url.pathname === "/v2/token/ingest/rotate")
        return { body: { name: "ingest", secret: "NEW" } };
      if (url.pathname === "/v2/token/ingest" && method === "GET") {
        return { body: { name: "ingest", secret: "OLD", description: "x", disabled: false } };
      }
      if (url.pathname === "/v2/token/ingest" && method === "PUT")
        return { body: { name: "ingest" } };
      return undefined;
    });
    const client = new SplunkObservabilityClient(CREDS, { http });
    const out = await client.exportCredential(
      "org-token",
      "acct:org-token:ingest",
      "acct",
      "rotate",
    );
    expect(out.content).toBe("NEW");
    await client.updateResource("org-token", "acct:org-token:ingest", "acct", { disabled: "true" });
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ name: "ingest", description: "x", disabled: true });
  });

  it("pauses synthetic tests by numeric id", async () => {
    const { http, calls } = makeHttp(() => ({ body: { success: true } }));
    await new SplunkObservabilityClient(CREDS, { http }).invokeAction(
      "synthetic-test",
      "acct:synthetic-test:42",
      "pause",
      "acct",
    );
    expect(calls[0]?.url.pathname).toBe("/v2/synthetics/tests/pause");
    expect(calls[0]?.body).toEqual({ testIds: [42] });
  });

  it("charts org usage through SignalFlow and derives quotas", async () => {
    const sse = [
      'event: control-message\ndata: {"event":"STREAM_START","timestampMs":1}',
      'event: metadata\ndata: {"tsId":"t1","properties":{"sf_streamLabel":"active-mts:used"}}',
      'event: metadata\ndata: {"tsId":"t2","properties":{"sf_streamLabel":"active-mts:limit"}}',
      'event: data\ndata: {"logicalTimestampMs":1000,"data":[{"tsId":"t1","value":10},{"tsId":"t2","value":100}]}',
      'event: data\ndata: {"logicalTimestampMs":2000,"data":[{"tsId":"t1","value":12},{"tsId":"t2","value":100}]}',
      'event: control-message\ndata: {"event":"END_OF_CHANNEL","timestampMs":3}',
    ].join("\n\n");
    const calls: Array<{ url: string; body?: unknown; headers: Record<string, string> }> = [];
    const http = {
      async request(req: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body?: string | Uint8Array;
      }) {
        calls.push({ url: req.url, body: req.body, headers: req.headers });
        return { status: 200, headers: {}, body: sse };
      },
    };
    const client = new SplunkObservabilityClient(CREDS, { http });
    const quotas = await client.fetchQuotas();
    expect(quotas).toEqual([
      {
        id: "active-mts",
        service: "Splunk Observability Cloud",
        name: "Active metric time series",
        used: 12,
        limit: 100,
        region: "us1",
      },
    ]);
    expect(calls[0]?.url).toContain(
      "https://stream.us1.observability.splunkcloud.com/v2/signalflow/execute?",
    );
    expect(calls[0]?.headers["Content-Type"]).toBe("text/plain");
  });

  it("creates a muting rule from friendly filters", async () => {
    const { http, calls } = makeHttp(() => ({ body: { id: "M1", description: "release" } }));
    await new SplunkObservabilityClient(CREDS, { http }).createResource("muting-rule", "acct", {
      description: "release",
      filters: "host=web-1, !env=dev",
      startTime: "1700000000000",
      stopTime: "",
      sendAlertsAfter: "true",
    });
    expect(calls[0]?.body).toEqual({
      description: "release",
      filters: [
        { property: "host", propertyValue: "web-1", NOT: false },
        { property: "env", propertyValue: "dev", NOT: true },
      ],
      startTime: 1700000000000,
      sendAlertsOnceMutingPeriodHasEnded: true,
    });
  });
});

describe("helpers", () => {
  it("finds detect labels and reconciles rules", () => {
    const program =
      "A = data('x').publish('A')\ndetect(when(A > threshold(5))).publish('High')\ndetect(when(A < 1)).publish(label=\"Low\")";
    expect(detectLabels(program)).toEqual(["High", "Low"]);
    expect(
      reconcileRules(program, [
        { detectLabel: "High", severity: "Critical" },
        { detectLabel: "Gone" },
      ]),
    ).toEqual([
      { detectLabel: "High", severity: "Critical" },
      { detectLabel: "Low", severity: "Warning", notifications: [] },
    ]);
  });

  it("rejects malformed muting filters", () => {
    expect(() => parseMutingFilters("justtext")).toThrow(/property=value/);
  });

  it("surfaces SignalFlow errors", () => {
    expect(() =>
      decodeSignalFlow('event: error\ndata: {"errors":[{"code":"ANALYTICS_PROGRAM_NAME_ERROR"}]}'),
    ).toThrow(/ANALYTICS_PROGRAM_NAME_ERROR/);
    expect(resolutionFor(24 * 3600_000)).toBe(300_000);
  });
});

describe("preflight", () => {
  it("probes each capability", async () => {
    const { http } = makeHttp((url) =>
      url.pathname === "/v2/token" ? { status: 403, body: {} } : { body: {} },
    );
    const res = await verifySplunkCredentials(
      new SplunkObservabilityClient(CREDS, { http }).context,
    );
    expect(res.checks.find((c) => c.capabilityId === "api")?.status).toBe("ok");
    expect(res.checks.find((c) => c.capabilityId === "tokens")?.status).toBe("missing");
  });
});

describe("terraform", () => {
  it("exports detectors with a dynamic rule block", () => {
    const r = mapDetector(
      "a",
      {
        id: "Dx",
        name: "CPU",
        programText: "detect(when(A>1)).publish('hi')",
        rules: [{ detectLabel: "hi", severity: "Major" }],
      },
      "https://app.us1.observability.splunkcloud.com",
    );
    const out = JSON.stringify(exportResourcesToTerraform([r], () => splunkTerraformExport));
    expect(out).toContain("signalfx_detector");
    expect(out).toContain('dynamic \\"rule\\"');
    expect(out).toContain("Dx");
  });
});
