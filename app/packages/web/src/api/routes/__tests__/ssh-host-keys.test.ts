import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

const mockSelect = vi.fn();
const mockDelete = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    select: (...a: unknown[]) => mockSelect(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
  },
}));

const mockTrustHostKey = vi.fn();
class HostKeyMismatchError extends Error {
  kind = "mismatch" as const;
  constructor(
    public host: string,
    public port: number,
    public presentedFingerprint: string,
    public storedFingerprint: string,
  ) {
    super("host key mismatch");
  }
}
class HostKeyTrustRequiredError extends Error {
  kind = "unknown" as const;
}
vi.mock("@/services/ssh-host-keys", () => ({
  trustHostKey: (...a: unknown[]) => mockTrustHostKey(...a),
  HostKeyMismatchError,
  HostKeyTrustRequiredError,
}));

const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { sshHostKeyRoutes } = await import("@/api/routes/ssh-host-keys");
const buildApp = () => buildTestApp(sshHostKeyRoutes);

const VALID_FP = "SHA256:abcDEF123";

describe("SSH host-key routes", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("GET /", () => {
    it("lists pinned fingerprints", async () => {
      const orderBy = vi.fn().mockResolvedValue([{ id: "p1", host: "h", port: 22 }]);
      const where = vi.fn().mockReturnValue({ orderBy });
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });

      const res = await buildApp().request("/");
      expect(res.status).toBe(200);
      expect((await res.json()).pins).toHaveLength(1);
    });
  });

  describe("POST /trust", () => {
    it("pins a fingerprint and audit-logs a 'trusted' action", async () => {
      mockTrustHostKey.mockResolvedValue(undefined);
      const res = await buildApp().request("/trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: "host.example.com", port: 22, fingerprint: VALID_FP }),
      });
      expect(res.status).toBe(200);
      expect(mockTrustHostKey).toHaveBeenCalledWith("org-1", "host.example.com", 22, VALID_FP);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "ssh_host_key.trusted" }),
      );
    });

    it("records a 'replaced' action when previousFingerprint is given", async () => {
      mockTrustHostKey.mockResolvedValue(undefined);
      await buildApp().request("/trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: "h",
          port: 22,
          fingerprint: VALID_FP,
          previousFingerprint: "SHA256:old",
        }),
      });
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "ssh_host_key.replaced" }),
      );
    });

    it("rejects an invalid body with 400", async () => {
      const res = await buildApp().request("/trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: "", port: 0, fingerprint: "not-a-fp" }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_body");
    });

    it("returns 409 when a concurrent connect observes a mismatch", async () => {
      mockTrustHostKey.mockRejectedValue(
        new HostKeyMismatchError("h", 22, "SHA256:new", "SHA256:stored"),
      );
      const res = await buildApp().request("/trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: "h", port: 22, fingerprint: VALID_FP }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("ssh_host_key_trust_required");
    });
  });

  describe("DELETE /:id", () => {
    it("removes an existing pin and audit-logs", async () => {
      const limit = vi.fn().mockResolvedValue([{ host: "h", port: 22, fingerprint: VALID_FP }]);
      const selWhere = vi.fn().mockReturnValue({ limit });
      const selFrom = vi.fn().mockReturnValue({ where: selWhere });
      mockSelect.mockReturnValue({ from: selFrom });

      const delWhere = vi.fn().mockResolvedValue(undefined);
      mockDelete.mockReturnValue({ where: delWhere });

      const res = await buildApp().request("/p1", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "ssh_host_key.removed" }),
      );
    });

    it("returns 404 when the pin does not exist", async () => {
      const limit = vi.fn().mockResolvedValue([]);
      const selWhere = vi.fn().mockReturnValue({ limit });
      const selFrom = vi.fn().mockReturnValue({ where: selWhere });
      mockSelect.mockReturnValue({ from: selFrom });

      const res = await buildApp().request("/missing", { method: "DELETE" });
      expect(res.status).toBe(404);
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });
});
