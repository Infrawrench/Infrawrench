import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

// `./ssh-host-keys` (imported for hostKeyTrustResponse) pulls in the real DB
// client at module load; stub it so no real connection is attempted.
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));

const mockSftpUpload = vi.fn();
const mockSftpDownloadToBuffer = vi.fn();
vi.mock("@/services/sftp", () => ({
  sftpUpload: (...a: unknown[]) => mockSftpUpload(...a),
  sftpDownloadToBuffer: (...a: unknown[]) => mockSftpDownloadToBuffer(...a),
}));

const mockGetClientForAccount = vi.fn();
vi.mock("@/services/plugin-clients", () => ({
  getClientForAccount: (...a: unknown[]) => mockGetClientForAccount(...a),
}));

const mockResolveSshConfig = vi.fn();
vi.mock("@/services/ssh", () => ({
  resolveSshConfig: (...a: unknown[]) => mockResolveSshConfig(...a),
}));

class HostKeyTrustRequiredError extends Error {
  kind = "unknown" as const;
  host = "h";
  port = 22;
  presentedFingerprint = "SHA256:p";
  storedFingerprint = null;
}
vi.mock("@/services/ssh-host-keys", () => ({ HostKeyTrustRequiredError }));

const { sftpRoutes } = await import("@/api/routes/sftp");
const buildApp = () => buildTestApp(sftpRoutes);

describe("SFTP routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSshConfig.mockResolvedValue({ host: "h", port: 22, username: "u" });
  });

  describe("POST /upload", () => {
    it("400s on missing fields", async () => {
      const fd = new FormData();
      fd.set("accountId", "a1");
      const res = await buildApp().request("/upload", { method: "POST", body: fd });
      expect(res.status).toBe(400);
    });

    it("404s when the account is not found", async () => {
      mockGetClientForAccount.mockResolvedValue(null);
      const fd = new FormData();
      fd.set("accountId", "a1");
      fd.set("remotePath", "/tmp/x");
      fd.set("file", new File(["data"], "x"));
      const res = await buildApp().request("/upload", { method: "POST", body: fd });
      expect(res.status).toBe(404);
    });

    it("uploads to the remote path", async () => {
      mockGetClientForAccount.mockResolvedValue({ client: {} });
      mockSftpUpload.mockResolvedValue(undefined);
      const fd = new FormData();
      fd.set("accountId", "a1");
      fd.set("remotePath", "/tmp/x");
      fd.set("file", new File(["data"], "x"));
      const res = await buildApp().request("/upload", { method: "POST", body: fd });
      expect(res.status).toBe(200);
      expect(mockSftpUpload).toHaveBeenCalled();
    });

    it("returns 409 when upload raises a host-key trust error", async () => {
      mockGetClientForAccount.mockResolvedValue({ client: {} });
      mockSftpUpload.mockRejectedValue(new HostKeyTrustRequiredError());
      const fd = new FormData();
      fd.set("accountId", "a1");
      fd.set("remotePath", "/tmp/x");
      fd.set("file", new File(["data"], "x"));
      const res = await buildApp().request("/upload", { method: "POST", body: fd });
      expect(res.status).toBe(409);
    });
  });

  describe("GET /download", () => {
    it("400s on missing params", async () => {
      const res = await buildApp().request("/download?accountId=a1");
      expect(res.status).toBe(400);
    });

    it("400s on a non-JSON paths param", async () => {
      const res = await buildApp().request("/download?accountId=a1&paths=bogus");
      expect(res.status).toBe(400);
    });

    it("404s when the account is not found", async () => {
      mockGetClientForAccount.mockResolvedValue(null);
      const res = await buildApp().request(
        `/download?accountId=a1&paths=${encodeURIComponent('["/x"]')}`,
      );
      expect(res.status).toBe(404);
    });

    it("downloads a single file as an octet-stream", async () => {
      mockGetClientForAccount.mockResolvedValue({ client: {} });
      mockSftpDownloadToBuffer.mockResolvedValue(Buffer.from("hello"));
      const res = await buildApp().request(
        `/download?accountId=a1&paths=${encodeURIComponent('["/tmp/file.txt"]')}`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(res.headers.get("Content-Disposition")).toContain("file.txt");
    });

    it("returns 409 when single-file download hits a host-key trust error", async () => {
      mockGetClientForAccount.mockResolvedValue({ client: {} });
      mockSftpDownloadToBuffer.mockRejectedValue(new HostKeyTrustRequiredError());
      const res = await buildApp().request(
        `/download?accountId=a1&paths=${encodeURIComponent('["/tmp/file.txt"]')}`,
      );
      expect(res.status).toBe(409);
    });
  });
});
