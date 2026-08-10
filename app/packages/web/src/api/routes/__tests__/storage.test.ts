import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

const mockGetClientForAccount = vi.fn();
vi.mock("@/services/plugin-clients", () => ({
  getClientForAccount: (...a: unknown[]) => mockGetClientForAccount(...a),
}));

const mockStorageDriversGet = vi.fn();
vi.mock("@/services/drivers", () => ({
  storageDrivers: { get: (...a: unknown[]) => mockStorageDriversGet(...a) },
}));

// host-services pulls in server-core's db client, which throws at import time
// without DATABASE_URL. Downloads only need the http bridge from it.
vi.mock("@/services/host-services", () => ({
  buildPluginHostServices: vi.fn().mockResolvedValue({ http: { request: vi.fn() } }),
}));

const { storageRoutes } = await import("@/api/routes/storage");
const buildApp = () => buildTestApp(storageRoutes);

describe("Storage routes", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("POST /upload", () => {
    it("400s when required fields are missing", async () => {
      const fd = new FormData();
      fd.set("accountId", "a1");
      const res = await buildApp().request("/upload", { method: "POST", body: fd });
      expect(res.status).toBe(400);
    });

    it("404s when the account/plugin is not found", async () => {
      mockGetClientForAccount.mockResolvedValue(null);
      const fd = new FormData();
      fd.set("accountId", "a1");
      fd.set("bucket", "b");
      fd.set("key", "k");
      fd.set("file", new File(["data"], "f.txt"));
      const res = await buildApp().request("/upload", { method: "POST", body: fd });
      expect(res.status).toBe(404);
    });

    it("400s when the plugin lacks upload support", async () => {
      mockGetClientForAccount.mockResolvedValue({ client: {} });
      const fd = new FormData();
      fd.set("accountId", "a1");
      fd.set("bucket", "b");
      fd.set("key", "k");
      fd.set("file", new File(["data"], "f.txt"));
      const res = await buildApp().request("/upload", { method: "POST", body: fd });
      expect(res.status).toBe(400);
    });

    it("uploads via the plugin client", async () => {
      const uploadStorageObject = vi.fn().mockResolvedValue(undefined);
      mockGetClientForAccount.mockResolvedValue({ client: { uploadStorageObject } });
      const fd = new FormData();
      fd.set("accountId", "a1");
      fd.set("bucket", "b");
      fd.set("key", "k");
      fd.set("file", new File(["data"], "f.txt"));
      const res = await buildApp().request("/upload", { method: "POST", body: fd });
      expect(res.status).toBe(200);
      expect(uploadStorageObject).toHaveBeenCalledWith("b", "k", expect.anything());
    });
  });

  describe("GET /download", () => {
    it("400s on missing params", async () => {
      const res = await buildApp().request("/download?accountId=a1");
      expect(res.status).toBe(400);
    });

    it("400s on a non-JSON keys param", async () => {
      const res = await buildApp().request("/download?accountId=a1&bucket=b&keys=notjson");
      expect(res.status).toBe(400);
    });

    it("400s when keys is not an array", async () => {
      const res = await buildApp().request(
        `/download?accountId=a1&bucket=b&keys=${encodeURIComponent('"x"')}`,
      );
      expect(res.status).toBe(400);
    });

    it("400s on an empty keys array", async () => {
      const res = await buildApp().request(
        `/download?accountId=a1&bucket=b&keys=${encodeURIComponent("[]")}`,
      );
      expect(res.status).toBe(400);
    });

    it("400s when too many keys are requested", async () => {
      const tooMany = JSON.stringify(Array.from({ length: 101 }, (_, i) => `k${i}`));
      const res = await buildApp().request(
        `/download?accountId=a1&bucket=b&keys=${encodeURIComponent(tooMany)}`,
      );
      expect(res.status).toBe(400);
    });

    it("404s when the account is not found", async () => {
      mockGetClientForAccount.mockResolvedValue(null);
      const res = await buildApp().request(
        `/download?accountId=a1&bucket=b&keys=${encodeURIComponent('["k"]')}`,
      );
      expect(res.status).toBe(404);
    });

    it("400s when the plugin lacks storage access tokens", async () => {
      mockGetClientForAccount.mockResolvedValue({ client: {}, account: { pluginId: "p" } });
      const res = await buildApp().request(
        `/download?accountId=a1&bucket=b&keys=${encodeURIComponent('["k"]')}`,
      );
      expect(res.status).toBe(400);
    });

    it("400s when there is no storage driver for the plugin", async () => {
      mockGetClientForAccount.mockResolvedValue({
        client: { getStorageAccessToken: vi.fn().mockResolvedValue("tok") },
        account: { pluginId: "p" },
      });
      mockStorageDriversGet.mockReturnValue(undefined);
      const res = await buildApp().request(
        `/download?accountId=a1&bucket=b&keys=${encodeURIComponent('["k"]')}`,
      );
      expect(res.status).toBe(400);
    });
  });
});
