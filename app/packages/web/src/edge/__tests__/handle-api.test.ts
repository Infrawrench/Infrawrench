import { describe, expect, it, vi } from "vitest";
import { handleEdgeApi, type EdgeApiDeps } from "../handle-api";

const URL_BASE = "https://app.example.com/api/org/org_1/accounts/acc_1/resources";

function deps(overrides: Partial<EdgeApiDeps> = {}): EdgeApiDeps & {
  forward: ReturnType<typeof vi.fn>;
  apiFetch: ReturnType<typeof vi.fn>;
  markAccountRequiresGateway: ReturnType<typeof vi.fn>;
} {
  return {
    apiFetch: vi.fn(async () => Response.json({ edge: true })),
    forward: vi.fn(async () => Response.json({ gateway: true })),
    accountNeedsGateway: vi.fn(async () => false),
    markAccountRequiresGateway: vi.fn(async () => {}),
    gatewayOnlyHit: () => undefined,
    waitUntil: () => {},
    ...overrides,
  } as never;
}

async function body(res: Response): Promise<unknown> {
  return res.json();
}

describe("handleEdgeApi", () => {
  it("answers from the edge when nothing needs the gateway", async () => {
    const d = deps();
    const res = await handleEdgeApi(new Request(URL_BASE), "acc_1", d);
    expect(await body(res)).toEqual({ edge: true });
    expect(d.forward).not.toHaveBeenCalled();
  });

  it("forwards without running the API when the account is known to need the gateway", async () => {
    const d = deps({ accountNeedsGateway: vi.fn(async () => true) });
    const res = await handleEdgeApi(new Request(URL_BASE), "acc_1", d);
    expect(await body(res)).toEqual({ gateway: true });
    expect(d.apiFetch).not.toHaveBeenCalled();
  });

  it("replays a read on the gateway when a handler swallowed a gateway-only hit", async () => {
    // The Postgres plugin's shape: the stub threw, the plugin caught it and
    // answered with placeholders, and only the scope knows.
    const d = deps({ gatewayOnlyHit: () => "node-only module.Client" });
    const res = await handleEdgeApi(new Request(URL_BASE), "acc_1", d);
    expect(await body(res)).toEqual({ gateway: true });
    expect(d.markAccountRequiresGateway).toHaveBeenCalledWith("acc_1", "node-only module.Client");
  });

  it("replays a read whose handler re-wrapped the error into its own body", async () => {
    const d = deps({
      apiFetch: vi.fn(async () =>
        Response.json(
          { error: "list failed: [gateway-only] The redis driver needs the Node gateway" },
          { status: 502 },
        ),
      ),
    });
    const res = await handleEdgeApi(new Request(URL_BASE), undefined, d);
    expect(await body(res)).toEqual({ gateway: true });
    expect(d.markAccountRequiresGateway).not.toHaveBeenCalled();
  });

  it("asks for a retry instead of replaying a write, and flags the account", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps({
      apiFetch: vi.fn(async () =>
        Response.json({ error: "x" }, { status: 503, headers: { "x-iw-gateway-only": "1" } }),
      ),
    });
    const res = await handleEdgeApi(
      new Request(URL_BASE, { method: "POST", body: "{}" }),
      "acc_1",
      d,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(d.forward).not.toHaveBeenCalled();
    expect(d.markAccountRequiresGateway).toHaveBeenCalledWith("acc_1", "error handler");
    warn.mockRestore();
  });

  it("leaves ordinary errors alone", async () => {
    const d = deps({
      apiFetch: vi.fn(async () => Response.json({ error: "Not found" }, { status: 404 })),
    });
    const res = await handleEdgeApi(new Request(URL_BASE), "acc_1", d);
    expect(res.status).toBe(404);
    expect(d.forward).not.toHaveBeenCalled();
  });
});
