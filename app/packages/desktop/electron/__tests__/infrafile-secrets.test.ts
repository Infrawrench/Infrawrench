import { beforeEach, describe, expect, it, vi } from "vitest";

const prepare = vi.fn();
vi.mock("../db", () => ({
  getSqlite: () => Promise.resolve({ prepare }),
}));
vi.mock("../drivers", () => ({
  sqlDrivers: new Map(),
  kvDrivers: new Map(),
  dockerDrivers: new Map(),
  k8sDrivers: new Map(),
}));
vi.mock("../instance-pricing-client", () => ({ mainInstancePricing: {} }));
vi.mock("../provider-oauth/local-accounts", () => ({
  getOAuthProvider: vi.fn(),
  loadLocalAccountCredentials: vi.fn(),
}));
vi.mock("../infrafile/plugins", () => ({ getPlugin: vi.fn() }));

import { buildAad, encryptValue } from "../main-utils";
import { secretHostServices } from "../infrafile/plugin-host";

const KEY = vi.hoisted(() => Buffer.alloc(32, 7));
vi.mock("../main-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../main-utils")>()),
  getEncryptionKey: () => KEY,
}));

function stubRow(row: Record<string, unknown> | null): void {
  let stepped = false;
  prepare.mockReturnValue({
    bind: vi.fn(),
    free: vi.fn(),
    step: () => {
      if (row === null || stepped) return false;
      stepped = true;
      return true;
    },
    getAsObject: () => row,
  });
}

beforeEach(() => prepare.mockReset());

describe("the CLI's secret store", () => {
  it("reads back what the app wrote", async () => {
    // As `setPlaintext` in plugin-runtime.ts and `secret_field_encrypt` in main.ts write it.
    const aad = buildAad("secretField", "r1:password", "value");
    const { ciphertext, iv } = encryptValue("hunter2", KEY, aad);
    stubRow({ resolution_kind: "literal", encrypted_value: ciphertext, value_iv: iv });
    await expect(secretHostServices.getPlaintext("r1", "password")).resolves.toBe("hunter2");
  });

  it("rejects a stored value it cannot decrypt, rather than read it as none", async () => {
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    const { ciphertext, iv } = encryptValue("hunter2", KEY, "some other aad");
    stubRow({ resolution_kind: "literal", encrypted_value: ciphertext, value_iv: iv });
    await expect(secretHostServices.getPlaintext("r1", "password")).rejects.toMatchObject({
      name: "SecretReadError",
      incompleteList: true,
    });
  });

  it("reads a row that is not there as no secret", async () => {
    stubRow(null);
    await expect(secretHostServices.getPlaintext("r1", "password")).resolves.toBeNull();
  });
});
