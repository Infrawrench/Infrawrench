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

vi.mock("@/services/encryption", () => ({
  encrypt: vi.fn().mockResolvedValue({ ciphertext: "enc", iv: "iv" }),
  buildAad: vi.fn().mockReturnValue("aad"),
}));

vi.mock("uuid", () => ({ v4: () => "assoc-uuid-1" }));

const { associationRoutes } = await import("@/api/routes/associations");
const buildApp = () => buildTestApp(associationRoutes);

function resourceExists(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  mockSelect.mockReturnValue({ from });
}

function setupUpsert() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  mockInsert.mockReturnValue({ values });
  return values;
}

describe("Association routes", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("POST /", () => {
    it("returns 404 when the consumer resource is not in the org", async () => {
      resourceExists([]);
      const res = await buildApp().request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consumerResourceId: "r1",
          consumerFieldKey: "DB_URL",
          providerResourceId: "p1",
          providerOutputKey: "uri",
          providerPluginId: "pg",
          providerResourceTypeId: "db",
          providerAccountId: "a1",
        }),
      });
      expect(res.status).toBe(404);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("upserts the association and secret field state", async () => {
      resourceExists([{ id: "r1" }]);
      setupUpsert();
      const res = await buildApp().request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consumerResourceId: "r1",
          consumerFieldKey: "DB_URL",
          providerResourceId: "p1",
          providerOutputKey: "uri",
          providerPluginId: "pg",
          providerResourceTypeId: "db",
          providerAccountId: "a1",
        }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
      // associations + secretFieldStates upserts
      expect(mockInsert).toHaveBeenCalledTimes(2);
    });
  });

  describe("POST /literal", () => {
    it("returns 404 when resource is missing", async () => {
      resourceExists([]);
      const res = await buildApp().request("/literal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceId: "r1", fieldKey: "K", plaintextValue: "v" }),
      });
      expect(res.status).toBe(404);
    });

    it("encrypts the literal and deletes any prior association", async () => {
      resourceExists([{ id: "r1" }]);
      setupUpsert();
      const where = vi.fn().mockResolvedValue(undefined);
      mockDelete.mockReturnValue({ where });

      const res = await buildApp().request("/literal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceId: "r1", fieldKey: "API_KEY", plaintextValue: "secret" }),
      });
      expect(res.status).toBe(200);
      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockDelete).toHaveBeenCalledTimes(1);
    });
  });
});
