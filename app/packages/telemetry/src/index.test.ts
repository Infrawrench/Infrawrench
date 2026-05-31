import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- pg mock ---
const connect = vi.fn();
const query = vi.fn();
const end = vi.fn();
const ClientCtor = vi.fn();

vi.mock("pg", () => ({
  Client: class {
    connectionString: string | undefined;
    constructor(cfg: { connectionString?: string }) {
      this.connectionString = cfg?.connectionString;
      ClientCtor(cfg);
    }
    connect = (...a: unknown[]) => connect(...a);
    query = (...a: unknown[]) => query(...a);
    end = (...a: unknown[]) => end(...a);
  },
}));

import app from "./index";

const CONN = "postgres://hyperdrive/local";

function makeEnv() {
  return { HYPERDRIVE: { connectionString: CONN } };
}

function makeCtx() {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
}

async function post(body: unknown, opts: { raw?: string } = {}) {
  const env = makeEnv();
  const ctx = makeCtx();
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: opts.raw !== undefined ? opts.raw : JSON.stringify(body),
  };
  const res = await app.request("/api/hello", init, env, ctx as unknown as ExecutionContext);
  return { res, ctx, env };
}

beforeEach(() => {
  vi.clearAllMocks();
  connect.mockResolvedValue(undefined);
  query.mockResolvedValue({ rows: [] });
  end.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/hello", () => {
  it("rejects non-JSON bodies with 400 invalid_json", async () => {
    const { res } = await post(undefined, { raw: "not json{" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects a missing token with 400 invalid_token", async () => {
    const { res } = await post({ osVersion: "14.0" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });

  it("rejects a token that fails the pattern (too short)", async () => {
    const { res } = await post({ token: "abc" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });

  it("rejects a token with illegal characters", async () => {
    const { res } = await post({ token: "has spaces and !@#$%" });
    expect(res.status).toBe(400);
  });

  it("rejects a whitespace-only token", async () => {
    const { res } = await post({ token: "          " });
    expect(res.status).toBe(400);
  });

  it("accepts a valid token and writes to postgres", async () => {
    const { res, ctx } = await post({
      token: "valid_token-123",
      osVersion: "macOS 14.5",
      arch: "arm64",
      cpu: "Apple M3",
      ram: 17179869184,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(ClientCtor).toHaveBeenCalledWith({ connectionString: CONN });
    expect(connect).toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
    const params = query.mock.calls[0]![1] as unknown[];
    expect(params[0]).toBe("valid_token-123");
    expect(params[1]).toBe("macOS 14.5");
    expect(params[2]).toBe("arm64");
    expect(params[3]).toBe("Apple M3");
    expect(params[4]).toBe(17179869184n);
    // connection cleanup deferred to waitUntil
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("stores null for absent optional fields", async () => {
    await post({ token: "another_valid_token" });
    const params = query.mock.calls[0]![1] as unknown[];
    expect(params[1]).toBeNull(); // osVersion
    expect(params[2]).toBeNull(); // arch
    expect(params[3]).toBeNull(); // cpu
    expect(params[4]).toBeNull(); // ram
  });

  it("parses a numeric-string ram value into a bigint", async () => {
    await post({ token: "valid_token_str", ram: "8589934592" });
    const params = query.mock.calls[0]![1] as unknown[];
    expect(params[4]).toBe(8589934592n);
  });

  it("treats a negative ram number as null", async () => {
    await post({ token: "valid_token_neg", ram: -5 });
    const params = query.mock.calls[0]![1] as unknown[];
    expect(params[4]).toBeNull();
  });

  it("treats a non-finite ram number as null", async () => {
    await post({ token: "valid_token_nan", ram: Number.POSITIVE_INFINITY });
    const params = query.mock.calls[0]![1] as unknown[];
    expect(params[4]).toBeNull();
  });

  it("treats a non-numeric ram string as null", async () => {
    await post({ token: "valid_token_bad", ram: "12.5gb" });
    const params = query.mock.calls[0]![1] as unknown[];
    expect(params[4]).toBeNull();
  });

  it("floors a fractional ram number", async () => {
    await post({ token: "valid_token_frac", ram: 1024.9 });
    const params = query.mock.calls[0]![1] as unknown[];
    expect(params[4]).toBe(1024n);
  });

  it("truncates an over-long osVersion to 256 chars", async () => {
    const long = "x".repeat(500);
    await post({ token: "valid_token_long", osVersion: long });
    const params = query.mock.calls[0]![1] as unknown[];
    expect((params[1] as string).length).toBe(256);
  });

  it("truncates arch to 32 chars", async () => {
    await post({ token: "valid_token_arch", arch: "a".repeat(100) });
    const params = query.mock.calls[0]![1] as unknown[];
    expect((params[2] as string).length).toBe(32);
  });

  it("ignores non-string optional fields", async () => {
    await post({ token: "valid_token_type", osVersion: 123, arch: {}, cpu: [] });
    const params = query.mock.calls[0]![1] as unknown[];
    expect(params[1]).toBeNull();
    expect(params[2]).toBeNull();
    expect(params[3]).toBeNull();
  });

  it("still closes the client (via waitUntil) when the query throws", async () => {
    query.mockRejectedValueOnce(new Error("db error"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { res, ctx } = await post({ token: "valid_token_err" });
    // Hono's default error handler surfaces a 500...
    expect(res.status).toBe(500);
    // ...but the finally block still schedules client.end() even on failure.
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});
