import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockDelete = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    select: (...a: unknown[]) => mockSelect(...a),
    insert: (...a: unknown[]) => mockInsert(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
  },
}));

const mockEncrypt = vi.fn();
const mockSendTestPage = vi.fn();
vi.mock("@infrawrench/server-core/twilio-pager", () => ({
  encryptTwilioCredential: (...a: unknown[]) => mockEncrypt(...a),
  sendTestPage: (...a: unknown[]) => mockSendTestPage(...a),
}));

const { twilioRoutes } = await import("@/api/routes/twilio");
const buildApp = () => buildTestApp(twilioRoutes);

describe("Twilio pager routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEncrypt.mockResolvedValue({ ciphertext: "enc", iv: "iv" });
  });

  describe("GET /", () => {
    it("returns defaults when no settings row exists", async () => {
      const where = vi.fn().mockResolvedValue([]);
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });

      const res = await buildApp().request("/");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ enabled: false, credentialsConfigured: false });
    });

    it("reports credentialsConfigured true when both secrets present", async () => {
      const where = vi.fn().mockResolvedValue([
        {
          enabled: true,
          fromNumber: "+15551234567",
          failureThreshold: 2,
          windowMinutes: 5,
          cooldownMinutes: 30,
          encryptedAccountSid: "x",
          encryptedAuthToken: "y",
        },
      ]);
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });

      const body = await (await buildApp().request("/")).json();
      expect(body.credentialsConfigured).toBe(true);
      // The encrypted secrets must never be echoed.
      expect(body).not.toHaveProperty("encryptedAccountSid");
    });
  });

  describe("PUT /", () => {
    function setupUpsert() {
      const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
      const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
      mockInsert.mockReturnValue({ values });
      return values;
    }

    it("rejects a non-E.164 fromNumber", async () => {
      const res = await buildApp().request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromNumber: "5551234" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects a sub-minimum failureThreshold", async () => {
      const res = await buildApp().request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ failureThreshold: 0 }),
      });
      expect(res.status).toBe(400);
    });

    it("encrypts accountSid + authToken on update", async () => {
      setupUpsert();
      const res = await buildApp().request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, accountSid: "AC123", authToken: "tok" }),
      });
      expect(res.status).toBe(200);
      expect(mockEncrypt).toHaveBeenCalledWith("org-1", "accountSid", "AC123");
      expect(mockEncrypt).toHaveBeenCalledWith("org-1", "authToken", "tok");
    });

    it("rejects an empty accountSid", async () => {
      setupUpsert();
      const res = await buildApp().request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountSid: "   " }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("recipients", () => {
    it("lists recipients", async () => {
      const orderBy = vi.fn().mockResolvedValue([
        {
          id: "r1",
          displayName: "On-call",
          phoneNumber: "+15551234567",
          sms: true,
          voice: false,
        },
      ]);
      const where = vi.fn().mockReturnValue({ orderBy });
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });

      const body = await (await buildApp().request("/recipients")).json();
      expect(body).toHaveLength(1);
      expect(body[0].displayName).toBe("On-call");
    });

    it("creates a recipient", async () => {
      const values = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values });

      const res = await buildApp().request("/recipients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Bob", phoneNumber: "+15551234567" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.displayName).toBe("Bob");
      expect(body.sms).toBe(true);
    });

    it("rejects a recipient with neither sms nor voice", async () => {
      const res = await buildApp().request("/recipients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "Bob",
          phoneNumber: "+15551234567",
          sms: false,
          voice: false,
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects a bad phone number", async () => {
      const res = await buildApp().request("/recipients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Bob", phoneNumber: "555" }),
      });
      expect(res.status).toBe(400);
    });

    it("deletes a recipient, 404 when missing", async () => {
      const returning = vi.fn().mockResolvedValue([]);
      const where = vi.fn().mockReturnValue({ returning });
      mockDelete.mockReturnValue({ where });
      const res = await buildApp().request("/recipients/r9", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /test", () => {
    it("returns the test page summary", async () => {
      mockSendTestPage.mockResolvedValue({ sent: 2 });
      const res = await buildApp().request("/test", { method: "POST" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, sent: 2 });
    });

    it("returns 400 with the error message on failure", async () => {
      mockSendTestPage.mockRejectedValue(new Error("not configured"));
      const res = await buildApp().request("/test", { method: "POST" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("not configured");
    });
  });
});
