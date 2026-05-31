import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
vi.mock("../../db/client", () => ({ db: { select: (...a: unknown[]) => mockSelect(...a) } }));
vi.mock("../../db/schema", () => ({ secretFieldStates: { resourceId: "rid" } }));

const mockDecrypt = vi.fn();
vi.mock("../encryption", () => ({
  decrypt: (...a: unknown[]) => mockDecrypt(...a),
  buildAad: vi.fn().mockReturnValue("aad"),
}));

const { loadSecretStatesForResource } = await import("../secret-states");

function selectRows(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  mockSelect.mockReturnValue({ from });
}

describe("loadSecretStatesForResource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns an empty list when there are no rows", async () => {
    selectRows([]);
    expect(await loadSecretStatesForResource("r1")).toEqual([]);
  });

  it("decrypts a literal value into plaintext resolution", async () => {
    selectRows([
      {
        resolutionKind: "literal",
        fieldKey: "password",
        resourceId: "r1",
        encryptedValue: "enc",
        valueIv: "iv",
      },
    ]);
    mockDecrypt.mockResolvedValue("hunter2");
    const states = await loadSecretStatesForResource("r1");
    expect(states[0]).toEqual({
      fieldKey: "password",
      resolution: { kind: "plaintext", value: "hunter2" },
    });
  });

  it("yields empty plaintext when decryption fails", async () => {
    selectRows([
      {
        resolutionKind: "literal",
        fieldKey: "password",
        resourceId: "r1",
        encryptedValue: "enc",
        valueIv: "iv",
      },
    ]);
    mockDecrypt.mockRejectedValue(new Error("bad key"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const states = await loadSecretStatesForResource("r1");
    expect(states[0]!.resolution).toEqual({ kind: "plaintext", value: "" });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("yields empty plaintext when literal has no ciphertext", async () => {
    selectRows([
      {
        resolutionKind: "literal",
        fieldKey: "k",
        resourceId: "r1",
        encryptedValue: null,
        valueIv: null,
      },
    ]);
    const states = await loadSecretStatesForResource("r1");
    expect(states[0]!.resolution).toEqual({ kind: "plaintext", value: "" });
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it("maps an output-ref row with cached fields", async () => {
    const cachedAt = new Date("2026-01-02T03:04:05.000Z");
    selectRows([
      {
        resolutionKind: "output-ref",
        fieldKey: "connStr",
        resourceId: "r1",
        sourcePluginId: "gcp",
        sourceResourceTypeId: "sql",
        sourceResourceId: "db1",
        sourceAccountId: "acct1",
        sourceOutputKey: "connectionString",
        cachedEncryptedValue: "cev",
        cachedValueIv: "civ",
        cachedAt,
      },
    ]);
    const states = await loadSecretStatesForResource("r1");
    expect(states[0]!.resolution).toEqual({
      kind: "output-ref",
      sourcePluginId: "gcp",
      sourceResourceTypeId: "sql",
      sourceResourceId: "db1",
      sourceAccountId: "acct1",
      outputKey: "connectionString",
      cachedEncryptedValue: "cev",
      cachedIv: "civ",
      cachedAt: cachedAt.toISOString(),
    });
  });

  it("maps an output-ref row with null source fields to empty strings", async () => {
    selectRows([
      {
        resolutionKind: "output-ref",
        fieldKey: "x",
        resourceId: "r1",
        sourcePluginId: null,
        sourceResourceTypeId: null,
        sourceResourceId: null,
        sourceAccountId: null,
        sourceOutputKey: null,
        cachedEncryptedValue: null,
        cachedValueIv: null,
        cachedAt: null,
      },
    ]);
    const states = await loadSecretStatesForResource("r1");
    expect(states[0]!.resolution).toEqual({
      kind: "output-ref",
      sourcePluginId: "",
      sourceResourceTypeId: "",
      sourceResourceId: "",
      sourceAccountId: "",
      outputKey: "",
    });
  });
});
