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
  const raw = (method: "GET" | "POST" | "DELETE", url: string) =>
    DesktopRpcClient.use((rpc) => rpc.CloudHttp({ method, url }));

  it("refuses a route no registered domain or the Settings surface declares", async () => {
    for (const url of [
      `/api/org/${ORG}/admin/users`,
      `/api/org/${ORG}/probes/${PROBE}/../../billing/portal`,
      `/api/org/${ORG}/probes/a%2F..%2Fb`,
      "//evil.test/api/profile",
    ]) {
      const error = await failureOf(raw("GET", url));
      expect(error._tag).toBe("CloudRequestError");
      expect(error.message).toContain("is not on the desktop's cloud API surface");
    }
    // A registered path with a method its endpoint does not declare.
    const wrongMethod = await failureOf(raw("POST", `/api/org/${ORG}/probes/suggestions`));
    expect(wrongMethod.message).toContain("is not on the desktop's cloud API surface");
    expect(h.fetch).not.toHaveBeenCalled();
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
});
