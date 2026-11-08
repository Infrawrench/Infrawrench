/**
 * The renderer clients of the areas on the cloud transport (probes, SLOs and
 * the Settings sections), against a fake `CloudHttp`: what each call sends,
 * and what the panel gets back or sees as the error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);
vi.mock("../rpc/desktop-client", async () => (await import("./fake-rpc")).fakeRpcClientModule);

let activeCloudOrgId: string | null = "org-1";
vi.mock("@infrawrench/ui", () => ({
  useUIStore: { getState: () => ({ activeCloudOrgId }) },
}));

const { answerCloudHttp, resetFakeRpc } = await import("./fake-rpc");
const { createDesktopProbesClient } = await import("../probes-client");
const { createDesktopSlosClient } = await import("../slos-client");
const { createDesktopSettingsApi, requestText } = await import("../settings-client");
const { PlanRequiredClientError, SeatLimitReachedClientError } =
  await import("@infrawrench/client-core");

beforeEach(() => {
  resetFakeRpc();
  activeCloudOrgId = "org-1";
});

describe("the probes client", () => {
  it("lists the probes of the active org", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { probes: [{ id: "p1" }] } }));

    await expect(createDesktopProbesClient().listProbes()).resolves.toEqual([{ id: "p1" }]);
    expect(http).toHaveBeenCalledWith({ method: "GET", url: "/api/org/org-1/probes" });
  });

  it("sends only the create fields the endpoint takes", async () => {
    const http = answerCloudHttp(() => ({ status: 201, json: { id: "p1" } }));

    await createDesktopProbesClient().createProbe?.({
      name: "API",
      url: "https://api.example.test",
      intervalSeconds: 60,
      accountId: "a1",
      pluginId: "aws",
      resourceTypeId: "alb",
      resourceId: null,
      outputKey: "dnsName",
    });

    expect(http.mock.calls[0]?.[0]).toEqual({
      method: "POST",
      url: "/api/org/org-1/probes",
      body: JSON.stringify({
        name: "API",
        url: "https://api.example.test",
        intervalSeconds: 60,
        outputKey: "dnsName",
      }),
    });
  });

  it("reads the series for a range", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { series: [] } }));

    await createDesktopProbesClient().probeMetrics("p 1", { startMs: 10, endMs: 20 });

    expect(http).toHaveBeenCalledWith({
      method: "GET",
      url: "/api/org/org-1/probes/p%201/metrics?startMs=10&endMs=20",
    });
  });

  it("shows the server's failure in the words the handlers used", async () => {
    answerCloudHttp(() => ({ status: 500, json: { error: "boom" } }));

    await expect(createDesktopProbesClient().listProbes()).rejects.toThrow(
      'Cloud request failed: 500 /probes {"error":"boom"}',
    );
  });

  it("needs cloud mode", async () => {
    activeCloudOrgId = null;

    await expect(createDesktopProbesClient().listProbes()).rejects.toThrow(
      "Synthetic probes require cloud mode: sign in to sync.",
    );
  });
});

describe("the SLOs client", () => {
  it("starts a freeze of a preset length", async () => {
    const http = answerCloudHttp(() => ({
      status: 201,
      json: { id: "f1", name: "x", endsAt: null },
    }));

    await createDesktopSlosClient().startFreeze?.("s1", { durationHours: 72, reason: "burn" });

    expect(http).toHaveBeenCalledWith({
      method: "POST",
      url: "/api/org/org-1/slos/s1/freeze",
      body: JSON.stringify({ durationHours: 72, reason: "burn" }),
    });
  });

  it("refuses a freeze length the endpoint does not take, sending nothing", async () => {
    const http = answerCloudHttp(() => ({ status: 201, json: {} }));

    await expect(
      createDesktopSlosClient().startFreeze?.("s1", { durationHours: 5 }),
    ).rejects.toThrow("durationHours must be one of 24, 72, 168 or null");
    expect(http).not.toHaveBeenCalled();
  });

  it("deletes with an empty answer", async () => {
    answerCloudHttp(() => ({ status: 204 }));

    await expect(createDesktopSlosClient().deleteSlo?.("s1")).resolves.toBeUndefined();
  });
});

describe("the settings client", () => {
  it("sends the section's path and body as they are", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { ok: true } }));

    await expect(
      createDesktopSettingsApi().patch("/api/org/org-1/team/m1", { role: "admin" }),
    ).resolves.toEqual({ ok: true });
    expect(http).toHaveBeenCalledWith({
      method: "PATCH",
      url: "/api/org/org-1/team/m1",
      body: JSON.stringify({ role: "admin" }),
    });
  });

  it("rebuilds the typed errors the shared sections catch", async () => {
    const seatLimit = { error: "Seat limit reached", code: "seat_limit_reached" };
    answerCloudHttp((request) =>
      request.url.endsWith("/invitations")
        ? { status: 409, json: seatLimit }
        : { status: 402, json: { error: "Upgrade to use API keys" } },
    );
    const api = createDesktopSettingsApi();

    await expect(api.post("/api/org/org-1/team/invitations", {})).rejects.toBeInstanceOf(
      SeatLimitReachedClientError,
    );
    const planError = await api.get("/api/org/org-1/api-keys").catch((e: unknown) => e);
    expect(planError).toBeInstanceOf(PlanRequiredClientError);
    expect(planError).toHaveProperty("message", "Upgrade to use API keys");
  });

  it("returns a document's text unparsed", async () => {
    answerCloudHttp(() => ({ status: 200, json: "not parsed" }));

    await expect(requestText("/api/org/org-1/session-recordings/r1/cast")).resolves.toBe(
      '"not parsed"',
    );
  });
});
