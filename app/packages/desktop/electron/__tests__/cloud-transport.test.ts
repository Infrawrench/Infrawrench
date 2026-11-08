/**
 * The cloud transport end to end: the renderer's typed contract client
 * (`src/lib/cloud-client.ts`) and the settings client's `CloudHttp` calls,
 * through the real RPC server and the main process's real transport
 * (`electron/cloud-transport.ts`) and allowlist. Only the edges are fakes:
 * `fetch`, the token store and the host-key prompt's answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  fetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>(),
  getAccessToken: vi.fn<() => Promise<string | null>>(),
  forceRefreshAccessToken: vi.fn<() => Promise<string | null>>(),
  prompt: vi.fn<(input: { host: string; kind: string }) => Promise<boolean>>(),
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    ipcMain: new EventEmitter(),
    app: { getPath: () => "/tmp", isPackaged: false, getAppPath: () => "" },
  };
});
vi.mock("../cloud-tokens", () => ({
  getAccessToken: h.getAccessToken,
  forceRefreshAccessToken: h.forceRefreshAccessToken,
}));
vi.mock("../ssh-host-key-prompt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ssh-host-key-prompt")>()),
  promptHostKeyDecision: h.prompt,
}));

const { callDesktopRpc, failureOf } = await import("./rpc-harness");
const { DesktopRpcClient } = await import("../../src/lib/rpc/desktop-client");
const { cloudClient } = await import("../../src/lib/cloud-client");
const { CLOUD_URL } = await import("../../env");
const { DESKTOP_CLOUD_APIS } = await import("../../shared/cloud-apis");
const { handlerAuthenticatedEndpoints, isAllowedContractRequest } =
  await import("../cloud-allowlist");

const ORG = "11111111-1111-4111-8111-111111111111";
const PROBE = "22222222-2222-4222-8222-222222222222";
const SLO = "33333333-3333-4333-8333-333333333333";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function probe(overrides: Record<string, unknown> = {}) {
  return {
    id: PROBE,
    name: "API",
    url: "https://api.example.test/health",
    method: "GET",
    intervalSeconds: 60,
    timeoutMs: 10000,
    failureThreshold: 3,
    enabled: true,
    accountId: null,
    resourceId: null,
    pluginId: null,
    resourceTypeId: null,
    outputKey: null,
    status: "up",
    consecutiveFailures: 0,
    lastProbeAt: null,
    lastStatusCode: 200,
    lastLatencyMs: 42,
    lastError: null,
    lastStateChangeAt: null,
    uptime24h: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The headers of the `n`th `fetch` the main process made. */
const headersOf = (n: number) => new Headers(h.fetch.mock.calls[n]?.[1].headers);

/** The `fetch` calls the main process made, as `[method, url, authorization, body]`. */
function sent() {
  return h.fetch.mock.calls.map(([url, init]) => [
    init.method,
    url,
    new Headers(init.headers).get("Authorization"),
    init.body,
  ]);
}

const probes = cloudClient("probes").probes;
const slos = cloudClient("slos").slos;

beforeEach(() => {
  vi.stubGlobal("fetch", h.fetch);
  h.getAccessToken.mockResolvedValue("access-1");
  h.forceRefreshAccessToken.mockResolvedValue("access-2");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("the typed cloud client", () => {
  it("sends the endpoint's request with the session token and answers the body", async () => {
    h.fetch.mockResolvedValueOnce(json(200, { probes: [probe()] }));

    const answer = await callDesktopRpc(probes.list({ params: { orgId: ORG } }));

    expect(answer).toEqual({ probes: [probe()] });
    expect(sent()).toEqual([
      ["GET", `${CLOUD_URL}/api/org/${ORG}/probes`, "Bearer access-1", undefined],
    ]);
  });

  it("passes a newer server's unknown enum value and extra fields through untouched", async () => {
    const newer = probe({ status: "degraded", regionResults: [{ region: "eu", ok: false }] });
    h.fetch.mockResolvedValueOnce(json(200, { probes: [newer], nextCursor: "c2" }));

    const answer = await callDesktopRpc(probes.list({ params: { orgId: ORG } }));

    expect(answer).toEqual({ probes: [newer], nextCursor: "c2" });
  });

  it("encodes the query and the JSON body from the endpoint's schemas", async () => {
    h.fetch
      .mockResolvedValueOnce(json(200, { series: [] }))
      .mockResolvedValueOnce(json(201, probe()))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await callDesktopRpc(
      probes.metrics({
        params: { orgId: ORG, probeId: PROBE },
        query: { startMs: "1", endMs: "2" },
      }),
    );
    await callDesktopRpc(
      probes.create({
        params: { orgId: ORG },
        payload: { name: "API", url: "https://api.example.test/health", intervalSeconds: 120 },
      }),
    );
    const deleted = await callDesktopRpc(slos.delete({ params: { orgId: ORG, sloId: SLO } }));

    expect(deleted).toBeUndefined();
    expect(sent()).toEqual([
      [
        "GET",
        `${CLOUD_URL}/api/org/${ORG}/probes/${PROBE}/metrics?startMs=1&endMs=2`,
        "Bearer access-1",
        undefined,
      ],
      [
        "POST",
        `${CLOUD_URL}/api/org/${ORG}/probes`,
        "Bearer access-1",
        JSON.stringify({
          name: "API",
          url: "https://api.example.test/health",
          intervalSeconds: 120,
        }),
      ],
      ["DELETE", `${CLOUD_URL}/api/org/${ORG}/slos/${SLO}`, "Bearer access-1", undefined],
    ]);
    expect(new Headers(h.fetch.mock.calls[1]?.[1].headers).get("Content-Type")).toBe(
      "application/json",
    );
  });

  it("refuses a payload its schema rejects without sending anything", async () => {
    const error = await failureOf(
      probes.create({
        params: { orgId: ORG },
        payload: { name: "API", url: "https://api.example.test", intervalSeconds: 1.5 },
      }),
    );

    expect(error._tag).toBe("CloudRequestEncodeError");
    expect(error.message).toContain("Invalid probes.probes.create request");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("refuses a dot-segment path parameter", async () => {
    const error = await failureOf(probes.delete({ params: { orgId: ORG, probeId: ".." } }));

    expect(error._tag).toBe("CloudRequestEncodeError");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("fails a non-2xx answer with the sentence the per-channel handlers threw", async () => {
    h.fetch.mockResolvedValueOnce(json(404, { error: "Probe not found" }));

    const error = await failureOf(probes.delete({ params: { orgId: ORG, probeId: PROBE } }));

    expect(error).toMatchObject({
      _tag: "CloudResponseError",
      status: 404,
      body: '{"error":"Probe not found"}',
      message: `Cloud request failed: 404 /probes/${PROBE} {"error":"Probe not found"}`,
    });
  });
});

describe("the session", () => {
  it("refreshes the token once on a 401 and retries", async () => {
    h.fetch
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(json(200, { slos: [] }));

    const answer = await callDesktopRpc(slos.list({ params: { orgId: ORG } }));

    expect(answer).toEqual({ slos: [] });
    expect(h.forceRefreshAccessToken).toHaveBeenCalledTimes(1);
    expect(sent().map(([, , auth]) => auth)).toEqual(["Bearer access-1", "Bearer access-2"]);
  });

  it("asks the user to sign in again when the refresh fails", async () => {
    h.fetch.mockResolvedValueOnce(new Response("expired", { status: 401 }));
    h.forceRefreshAccessToken.mockResolvedValueOnce(null);

    const error = await failureOf(slos.list({ params: { orgId: ORG } }));

    expect(error).toMatchObject({
      _tag: "CloudRequestError",
      message: "Authentication expired; please sign in again",
    });
  });

  it("sends nothing when signed out", async () => {
    h.getAccessToken.mockResolvedValueOnce(null);

    const error = await failureOf(slos.list({ params: { orgId: ORG } }));

    expect(error).toMatchObject({
      _tag: "CloudRequestError",
      message: "Not authenticated to Infrawrench Cloud",
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("the SSH host-key prompt", () => {
  const trustRequired = {
    error: "ssh_host_key_trust_required",
    message: "Unknown host key",
    kind: "unknown",
    host: "bastion.example.test",
    port: 22,
    presentedFingerprint: "SHA256:abc",
    storedFingerprint: null,
  };

  it("trusts the key the user accepted and retries the request", async () => {
    h.prompt.mockResolvedValueOnce(true);
    h.fetch
      .mockResolvedValueOnce(json(409, trustRequired))
      .mockResolvedValueOnce(json(200, { ok: true }))
      .mockResolvedValueOnce(json(200, { slos: [] }));

    const answer = await callDesktopRpc(slos.list({ params: { orgId: ORG } }));

    expect(answer).toEqual({ slos: [] });
    expect(h.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ host: "bastion.example.test", kind: "first-connect" }),
    );
    expect(sent()).toEqual([
      ["GET", `${CLOUD_URL}/api/org/${ORG}/slos`, "Bearer access-1", undefined],
      [
        "POST",
        `${CLOUD_URL}/api/org/${ORG}/ssh-host-keys/trust`,
        "Bearer access-1",
        JSON.stringify({ host: "bastion.example.test", port: 22, fingerprint: "SHA256:abc" }),
      ],
      ["GET", `${CLOUD_URL}/api/org/${ORG}/slos`, "Bearer access-1", undefined],
    ]);
  });

  it("answers the 409 when the user declines", async () => {
    h.prompt.mockResolvedValueOnce(false);
    h.fetch.mockResolvedValueOnce(json(409, trustRequired));

    const error = await failureOf(slos.list({ params: { orgId: ORG } }));

    expect(error).toMatchObject({ _tag: "CloudResponseError", status: 409 });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("leaves any other 409 alone", async () => {
    h.fetch.mockResolvedValueOnce(json(409, { error: "Probe limit reached" }));

    const error = await failureOf(
      probes.create({ params: { orgId: ORG }, payload: { name: "x", url: "https://x.test" } }),
    );

    expect(error).toMatchObject({ _tag: "CloudResponseError", status: 409 });
    expect(h.prompt).not.toHaveBeenCalled();
  });
});

describe("the allowlist", () => {
  const raw = (method: "GET" | "POST" | "DELETE", url: string, headers?: Record<string, string>) =>
    DesktopRpcClient.use((rpc) => rpc.CloudHttp({ method, url, ...(headers ? { headers } : {}) }));

  const refusedWith = async (effect: ReturnType<typeof raw>, sentence: string) => {
    const error = await failureOf(effect);
    expect(error._tag).toBe("CloudRequestError");
    expect(error.message).toContain(sentence);
  };

  it("refuses a route no registered domain or the Settings surface declares", async () => {
    for (const url of [
      `/api/org/${ORG}/admin/users`,
      `/api/org/${ORG}/probes/${PROBE}/../../billing/portal`,
      `/api/org/${ORG}/probes/%2E%2E/suggestions`,
      "//evil.test/api/profile",
    ]) {
      await refusedWith(raw("GET", url), "is not on the desktop's cloud API surface");
    }
    // A registered path with a method its endpoint does not declare.
    await refusedWith(
      raw("POST", `/api/org/${ORG}/probes/suggestions`),
      "is not on the desktop's cloud API surface",
    );
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("refuses a registered endpoint that runs no auth middleware, so it never gets the token", async () => {
    // `PagingProvidersApi`'s inbound webhook, keyed by the token in its path.
    await refusedWith(
      raw("POST", "/api/paging-webhooks/hook-token"),
      "is not on the desktop's cloud API surface",
    );
    // `StatusPagesApi`'s public page.
    await refusedWith(raw("GET", "/api/status/acme"), "is not on the desktop's cloud API surface");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("refuses a streaming endpoint, which a buffered answer would hold until it ended", async () => {
    await refusedWith(
      raw("POST", `/api/org/${ORG}/chat/conversations/c1/messages`),
      "is not on the desktop's cloud API surface",
    );
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("serves an endpoint listed as authenticating in its handler", async () => {
    h.fetch.mockResolvedValueOnce(json(200, { ok: true }));

    await callDesktopRpc(raw("POST", `/api/org/${ORG}/chat/conversations/c1/pending/p1/answer`));

    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("lists by hand only registered endpoints that still lack the auth middleware", () => {
    const registered = new Map(
      Object.entries(DESKTOP_CLOUD_APIS).flatMap(([name, { endpoints }]) =>
        endpoints.map((entry) => [`${name}.${entry.group}.${entry.endpoint.identifier}`, entry]),
      ),
    );
    for (const id of handlerAuthenticatedEndpoints) {
      const entry = registered.get(id);
      expect(entry, id).toBeDefined();
      expect(entry?.authenticated, id).toBe(false);
      expect(entry?.answer, id).not.toBe("stream");
    }
  });

  it("serves the Settings surface with the status and body as data", async () => {
    h.fetch.mockResolvedValueOnce(json(409, { error: "seat_limit_reached", limit: 5 }));

    const answer = await callDesktopRpc(raw("GET", `/api/org/${ORG}/team`));

    expect(answer).toEqual({ status: 409, body: '{"error":"seat_limit_reached","limit":5}' });
  });

  it("lets an encoded slash through in a query value of a contract route", async () => {
    h.fetch.mockResolvedValueOnce(json(200, { series: [] }));

    await callDesktopRpc(raw("GET", `/api/org/${ORG}/probes/${PROBE}/metrics?startMs=%2F`));

    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("lets an encoded slash through inside a path parameter of a contract route", async () => {
    const arn = "arn:aws:ec2:us-east-1:1:instance/i-1";
    h.fetch.mockResolvedValueOnce(json(200, { service: { id: "svc-1" } }));

    await callDesktopRpc(
      cloudClient("services").services.removeMember({
        params: { orgId: ORG, serviceId: "svc-1", resourceId: arn },
      }),
    );

    expect(sent()).toEqual([
      [
        "DELETE",
        `${CLOUD_URL}/api/org/${ORG}/services/svc-1/members/arn%3Aaws%3Aec2%3Aus-east-1%3A1%3Ainstance%2Fi-1`,
        "Bearer access-1",
        undefined,
      ],
    ]);
    expect(
      isAllowedContractRequest("DELETE", `/api/org/${ORG}/services/svc-1/members/ns%5Cname`),
    ).toBe(true);
  });

  it("refuses a path parameter that is or decodes to a dot segment", () => {
    for (const member of ["..", ".", "%2E%2E", ".%2e", "%2e"]) {
      expect(
        isAllowedContractRequest("DELETE", `/api/org/${ORG}/services/svc-1/members/${member}`),
        member,
      ).toBe(false);
    }
  });

  it("keeps refusing an encoded slash anywhere in a Settings path", async () => {
    await refusedWith(
      raw("DELETE", `/api/org/${ORG}/team/a%2F..%2Fb`),
      "is not on the desktop's cloud API surface",
    );
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("request headers", () => {
  const run = (headers: { "x-change-freeze-override"?: string }) =>
    cloudClient("sshFanout").sshFanout.run({
      params: { orgId: ORG },
      headers,
      payload: { command: "uptime", targets: [{ kind: "account", id: "a1" }] },
    });

  it("sends a header the endpoint declares", async () => {
    h.fetch.mockResolvedValueOnce(json(200, { results: [] }));

    await callDesktopRpc(run({ "x-change-freeze-override": "true" }));

    expect(headersOf(0).get("x-change-freeze-override")).toBe("true");
    expect(headersOf(0).get("Authorization")).toBe("Bearer access-1");
  });

  it("leaves an optional header out, and the whole `headers` may be", async () => {
    h.fetch.mockResolvedValueOnce(json(200, { results: [] }));

    await callDesktopRpc(run({}));

    expect(headersOf(0).has("x-change-freeze-override")).toBe(false);
  });

  it("refuses a header the matched endpoint does not declare, or one the transport owns", async () => {
    const raw = (url: string, headers: Record<string, string>) =>
      DesktopRpcClient.use((rpc) => rpc.CloudHttp({ method: "POST", url, headers }));
    for (const [url, headers] of [
      [`/api/org/${ORG}/probes`, { "x-change-freeze-override": "true" }],
      [`/api/org/${ORG}/ssh-fanout/run`, { authorization: "Bearer stolen" }],
      [`/api/org/${ORG}/ssh-fanout/run`, { cookie: "session=1" }],
      [`/api/org/${ORG}/ssh-fanout/run`, { "X-Change-Freeze-Override": "true" }],
      [`/api/org/${ORG}/team`, { "x-change-freeze-override": "true" }],
    ] as const) {
      const error = await failureOf(raw(url, headers));
      expect(error.message).toContain("does not declare the");
    }
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("answers that are not JSON", () => {
  it("hands a text answer on as the server sent it", async () => {
    h.fetch.mockResolvedValueOnce(new Response("declare const graph: Graph;\n", { status: 200 }));

    const typings = await callDesktopRpc(
      cloudClient("customGraphs").customGraphs.typings({ params: { orgId: ORG } }),
    );

    expect(typings).toBe("declare const graph: Graph;\n");
  });

  it("carries a binary answer across the RPC byte for byte", async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x80, 0x0a]);
    h.fetch.mockResolvedValueOnce(new Response(zip, { status: 200 }));

    const pack = await callDesktopRpc(
      cloudClient("compliance").compliance.pack({
        params: { orgId: ORG },
        query: { framework: "soc2" },
      }),
    );

    expect(pack).toBeInstanceOf(Uint8Array);
    expect([...pack]).toEqual([...zip]);
    expect(sent()[0]?.[1]).toBe(`${CLOUD_URL}/api/org/${ORG}/compliance/pack?framework=soc2`);
  });

  it("fails a binary endpoint's error with its body read as text", async () => {
    h.fetch.mockResolvedValueOnce(json(404, { error: "Report not found" }));

    const error = await failureOf(
      cloudClient("dashboardNotifications").costReportPdf.pdf({
        params: { orgId: ORG, id: PROBE },
      }),
    );

    expect(error).toMatchObject({
      _tag: "CloudResponseError",
      status: 404,
      message: `Cloud request failed: 404 /cost-reports/${PROBE}/pdf {"error":"Report not found"}`,
    });
  });

  it("fails an empty body where the endpoint declares a JSON answer", async () => {
    h.fetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const error = await failureOf(probes.list({ params: { orgId: ORG } }));

    expect(error).toMatchObject({
      _tag: "CloudResponseError",
      message: "Infrawrench Cloud answered /probes with an empty body",
    });
  });
});

describe("the request encoder", () => {
  it("lets a query whose every key is optional be left out", async () => {
    h.fetch.mockResolvedValueOnce(new Response("a,b\n", { status: 200 }));

    await callDesktopRpc(
      cloudClient("accessReview").accessReview.export({ params: { orgId: ORG } }),
    );

    expect(sent()[0]?.[1]).toBe(`${CLOUD_URL}/api/org/${ORG}/access-review/export`);
  });

  it("sends back an enum value a newer server sent, which the schema does not know", async () => {
    const finding = {
      resourceId: "r1",
      ruleId: "access-review:shared-credential",
      title: "Shared",
      severity: "high",
      reason: "Used by two people",
      principal: {},
    };
    h.fetch
      .mockResolvedValueOnce(json(200, { findings: [finding] }))
      .mockResolvedValueOnce(json(200, { resourceId: "r1", ruleId: finding.ruleId }));
    const accessReview = cloudClient("accessReview").accessReview;

    const review = await callDesktopRpc(accessReview.review({ params: { orgId: ORG } }));
    const first = review.findings[0];
    if (!first) throw new Error("no finding");
    await callDesktopRpc(
      accessReview.dismiss({
        params: { orgId: ORG },
        payload: { resourceId: first.resourceId, ruleId: first.ruleId },
      }),
    );

    expect(sent()[1]?.[3]).toBe(
      JSON.stringify({ resourceId: "r1", ruleId: "access-review:shared-credential" }),
    );
  });
});
