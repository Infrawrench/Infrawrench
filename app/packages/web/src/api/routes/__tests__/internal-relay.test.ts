import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const runLocally = vi.fn();
const verifyRelaySecret = vi.fn();

class AppsHostError extends Error {
  constructor(
    message: string,
    readonly needsKey = false,
  ) {
    super(message);
    this.name = "AppsHostError";
  }
}

vi.mock("../../../services/apps-headless", () => ({
  runLocally: (...a: unknown[]) => runLocally(...a),
  encodeOpResult: (op: string, value: unknown) =>
    op === "screenshot"
      ? {
          png: (value as { png: Buffer }).png.toString("base64"),
          width: (value as { width: number }).width,
          height: (value as { height: number }).height,
        }
      : (value ?? null),
  AppsHostError,
}));
vi.mock("../../../services/replica-relay", () => ({
  verifyRelaySecret: (...a: unknown[]) => verifyRelaySecret(...a),
}));

const relayRoutes = (await import("../internal-relay")).default;

const app = new Hono();
app.route("/api/internal", relayRoutes);

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.request("/api/internal/relay", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const call = (over: Record<string, unknown> = {}) => ({
  kind: "linux-app",
  key: "org1:res1",
  op: "windows",
  payload: { organizationId: "org1", resourceId: "res1" },
  ...over,
});

beforeEach(() => {
  runLocally.mockReset();
  verifyRelaySecret.mockReset();
  verifyRelaySecret.mockReturnValue(true);
});

describe("internal relay", () => {
  it("refuses a call that does not carry the shared secret", async () => {
    // The only thing standing between this endpoint and anyone who can reach
    // the pod, so it is checked before the body is even parsed.
    verifyRelaySecret.mockReturnValue(false);
    const res = await post(call());
    expect(res.status).toBe(401);
    expect(runLocally).not.toHaveBeenCalled();
  });

  it("runs the operation locally and answers with its result", async () => {
    runLocally.mockResolvedValue([{ windowId: 1, title: "Firefox" }]);
    const res = await post(call());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ windowId: 1, title: "Firefox" }]);
    expect(runLocally).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org1", resourceId: "res1" }),
      "windows",
      expect.anything(),
    );
  });

  it("refuses a key that does not match the session in its payload", async () => {
    // The lease this call was routed on names one session; running it against
    // a different resource would drive the wrong customer's host.
    const res = await post(call({ key: "org1:someone-elses-resource" }));
    expect(res.status).toBe(400);
    expect(runLocally).not.toHaveBeenCalled();
  });

  it("refuses a payload whose organization is not the one in the key", async () => {
    const res = await post(call({ payload: { organizationId: "org2", resourceId: "res1" } }));
    expect(res.status).toBe(400);
    expect(runLocally).not.toHaveBeenCalled();
  });

  it("refuses an unknown operation rather than passing it through", async () => {
    const res = await post(call({ op: "rm -rf" }));
    expect(res.status).toBe(400);
    expect(runLocally).not.toHaveBeenCalled();
  });

  it("passes a host failure back with its message, not as a 500", async () => {
    // The forwarding pod re-raises this to whoever asked, so it has to arrive
    // explaining itself.
    runLocally.mockRejectedValue(new AppsHostError("This host is not running"));
    const res = await post(call());
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "This host is not running" });
  });

  it("base64s a screenshot, which JSON would otherwise mangle", async () => {
    runLocally.mockResolvedValue({ png: Buffer.from([1, 2, 3]), width: 4, height: 5 });
    const res = await post(
      call({
        op: "screenshot",
        payload: { organizationId: "org1", resourceId: "res1", windowId: 1 },
      }),
    );
    expect(await res.json()).toEqual({
      png: Buffer.from([1, 2, 3]).toString("base64"),
      width: 4,
      height: 5,
    });
  });
});
