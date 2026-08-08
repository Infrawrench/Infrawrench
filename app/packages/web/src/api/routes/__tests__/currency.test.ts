import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthSession } from "@/api/auth-middleware";
import { buildTestApp } from "./test-utils";

const mockGetConfig = vi.fn();
const mockSetDisplayCurrency = vi.fn();
const mockUpsertRate = vi.fn();
const mockDeleteRate = vi.fn();

/**
 * `CurrencySettingsError` is the module's own class, and the route branches on
 * `instanceof`. Re-declaring it in the mock (rather than importing the real
 * module, which reaches server-core's db client and throws at import time
 * without DATABASE_URL) keeps that branch reachable — same reason the anomaly
 * and tag-policy modules are mocked in `costs.test.ts`.
 */
class MockCurrencySettingsError extends Error {}

vi.mock("@infrawrench/server-core/cost/currency-settings", () => ({
  CurrencySettingsError: MockCurrencySettingsError,
  getOrgCurrencyConfig: (...args: unknown[]) => mockGetConfig(...args),
  setOrgDisplayCurrency: (...args: unknown[]) => mockSetDisplayCurrency(...args),
  upsertOrgExchangeRate: (...args: unknown[]) => mockUpsertRate(...args),
  deleteOrgExchangeRate: (...args: unknown[]) => mockDeleteRate(...args),
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { currencyRoutes } = await import("@/api/routes/currency");

const buildApp = () => buildTestApp(currencyRoutes);

/** App whose session carries only the given permissions. */
function buildAppWithPermissions(permissions: string[]): Hono {
  const app = new Hono();
  const session: AuthSession = { userId: "user-1", email: "test@example.com" };
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    throw err;
  });
  app.use("*", async (c, next) => {
    c.set("session", session);
    c.set("organizationId", "org-1");
    c.set("permissions", permissions);
    c.set("role", null);
    return next();
  });
  app.route("/", currencyRoutes);
  return app;
}

const json = (body: unknown) => ({
  method: "PUT",
  body: JSON.stringify(body),
  headers: { "Content-Type": "application/json" },
});

const storedRate = {
  id: "rate-1",
  fromCurrency: "EUR",
  toCurrency: "USD",
  rate: "1.0850000000",
  effectiveFrom: "2026-07-01",
  createdBy: "user-1",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockResolvedValue({ displayCurrency: null, rates: [] });
  mockSetDisplayCurrency.mockImplementation((_org: string, code: string | null) =>
    Promise.resolve({ displayCurrency: code }),
  );
  mockUpsertRate.mockResolvedValue(storedRate);
  mockDeleteRate.mockResolvedValue(true);
});

describe("GET /currency", () => {
  it("rejects without costs:read", async () => {
    const res = await buildAppWithPermissions(["dashboards:read"]).request("/");
    expect(res.status).toBe(403);
  });

  it("reads with costs:read alone — a converted total must be auditable", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/");
    expect(res.status).toBe(200);
  });

  it("returns the settings and rate table", async () => {
    mockGetConfig.mockResolvedValue({ displayCurrency: "USD", rates: [storedRate] });
    const res = await buildApp().request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ displayCurrency: "USD", rates: [storedRate] });
  });

  it("reports no display currency for an org that never opted in", async () => {
    const res = await buildApp().request("/");
    expect(await res.json()).toEqual({ displayCurrency: null, rates: [] });
  });
});

describe("PUT /currency", () => {
  it("rejects without org:settings:write", async () => {
    // costs:read is enough to look; changing what every total means is not a
    // cost-tuning act, it is finance governance.
    const res = await buildAppWithPermissions(["costs:read", "costs:write"]).request(
      "/",
      json({ displayCurrency: "USD" }),
    );
    expect(res.status).toBe(403);
  });

  it("sets the display currency", async () => {
    const res = await buildApp().request("/", json({ displayCurrency: "USD" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ displayCurrency: "USD" });
    expect(mockSetDisplayCurrency).toHaveBeenCalledWith("org-1", "USD");
  });

  it("upper-cases a lowercase code", async () => {
    await buildApp().request("/", json({ displayCurrency: "eur" }));
    expect(mockSetDisplayCurrency).toHaveBeenCalledWith("org-1", "EUR");
  });

  it("accepts null to turn conversion off", async () => {
    const res = await buildApp().request("/", json({ displayCurrency: null }));
    expect(res.status).toBe(200);
    expect(mockSetDisplayCurrency).toHaveBeenCalledWith("org-1", null);
  });

  it("rejects a body that omits the field rather than clearing the setting", async () => {
    const res = await buildApp().request("/", json({}));
    expect(res.status).toBe(400);
    expect(mockSetDisplayCurrency).not.toHaveBeenCalled();
  });

  it("rejects a non-code string", async () => {
    const res = await buildApp().request("/", json({ displayCurrency: "dollars" }));
    expect(res.status).toBe(400);
  });

  it("audit-logs the change", async () => {
    await buildApp().request("/", json({ displayCurrency: "USD" }));
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "currency_settings.update", entityId: "org-1" }),
    );
  });

  it("maps a CurrencySettingsError to a 400", async () => {
    mockSetDisplayCurrency.mockRejectedValue(new MockCurrencySettingsError("nope"));
    const res = await buildApp().request("/", json({ displayCurrency: "USD" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "nope" });
  });
});

describe("PUT /currency/rates", () => {
  const validRate = {
    fromCurrency: "EUR",
    toCurrency: "USD",
    rate: "1.0850",
    effectiveFrom: "2026-07-01",
  };

  it("rejects without org:settings:write", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/rates", json(validRate));
    expect(res.status).toBe(403);
  });

  it("stores a rate and records who stated it", async () => {
    const res = await buildApp().request("/rates", json(validRate));
    expect(res.status).toBe(200);
    expect(mockUpsertRate).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ fromCurrency: "EUR", toCurrency: "USD", rate: "1.0850" }),
      "user-1",
    );
  });

  it("keeps the rate a string so the org's digits survive", async () => {
    await buildApp().request("/rates", json({ ...validRate, rate: "1.234567890" }));
    expect(mockUpsertRate.mock.calls[0]![1]).toMatchObject({ rate: "1.234567890" });
  });

  it("rejects a zero rate rather than erasing a currency's spend", async () => {
    const res = await buildApp().request("/rates", json({ ...validRate, rate: "0" }));
    expect(res.status).toBe(400);
    expect(mockUpsertRate).not.toHaveBeenCalled();
  });

  it("rejects a negative rate", async () => {
    const res = await buildApp().request("/rates", json({ ...validRate, rate: "-1.1" }));
    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric rate", async () => {
    const res = await buildApp().request("/rates", json({ ...validRate, rate: "1,08" }));
    expect(res.status).toBe(400);
  });

  it("rejects a non-date effective_from", async () => {
    const res = await buildApp().request("/rates", json({ ...validRate, effectiveFrom: "July" }));
    expect(res.status).toBe(400);
  });

  it("audit-logs the rate", async () => {
    await buildApp().request("/rates", json(validRate));
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "exchange_rate.upsert", entityId: "rate-1" }),
    );
  });

  it("maps a CurrencySettingsError to a 400", async () => {
    mockUpsertRate.mockRejectedValue(new MockCurrencySettingsError("same currency"));
    const res = await buildApp().request("/rates", json(validRate));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "same currency" });
  });
});

describe("DELETE /currency/rates/:rateId", () => {
  it("rejects without org:settings:write", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/rates/rate-1", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });

  it("deletes and audit-logs", async () => {
    const res = await buildApp().request("/rates/rate-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(mockDeleteRate).toHaveBeenCalledWith("org-1", "rate-1");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "exchange_rate.delete" }),
    );
  });

  it("404s for another org's rate", async () => {
    mockDeleteRate.mockResolvedValue(false);
    const res = await buildApp().request("/rates/rate-9", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});
