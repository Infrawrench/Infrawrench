import { beforeEach, describe, expect, it, vi } from "vitest";

const selectRows: unknown[][] = [];
const updateSet = vi.fn();
const encrypt = vi.fn();
const decrypt = vi.fn();

function result(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  return {
    limit: () => promise,
    orderBy: () => promise,
    then: promise.then.bind(promise),
  };
}

vi.mock("../../db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => result(selectRows.shift() ?? []),
        innerJoin: () => ({
          where: () => result(selectRows.shift() ?? []),
        }),
      }),
    }),
    update: () => ({
      set: (value: unknown) => {
        updateSet(value);
        return { where: () => Promise.resolve() };
      },
    }),
    insert: () => ({ values: () => Promise.resolve() }),
    delete: () => ({ where: () => Promise.resolve() }),
    transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        delete: () => ({ where: () => Promise.resolve() }),
        insert: () => ({ values: () => Promise.resolve() }),
      }),
  },
}));

vi.mock("../../db/schema", () => ({
  workflowSecrets: {
    id: "id",
    organizationId: "organization_id",
    name: "name",
  },
  workflowSecretAssignments: {
    workflowId: "workflow_id",
    secretId: "secret_id",
  },
  workflows: { id: "id", organizationId: "organization_id" },
}));

vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => parts,
  asc: (value: unknown) => value,
  eq: (...parts: unknown[]) => parts,
  inArray: (...parts: unknown[]) => parts,
}));

vi.mock("@infrawrench/server-core/encryption", () => ({
  buildAad: (type: string, id: string, field: string) => `${type}:${id}:${field}`,
  encrypt: (...args: unknown[]) => encrypt(...args),
  decrypt: (...args: unknown[]) => decrypt(...args),
}));

const { loadAssignedWorkflowSecretValues, validateWorkflowSecretName, writeWorkflowSecretValue } =
  await import("../workflow-secrets");

function secret(overrides: Record<string, unknown> = {}) {
  return {
    id: "secret-1",
    organizationId: "org-1",
    name: "stripe.apiKey",
    description: null,
    encryptedValue: null,
    encryptedValueIv: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  selectRows.length = 0;
  vi.clearAllMocks();
});

describe("workflow secret names", () => {
  it("accepts JavaScript dot identifiers and rejects unsafe paths", () => {
    expect(validateWorkflowSecretName(" stripe.apiKey ")).toBe("stripe.apiKey");
    expect(() => validateWorkflowSecretName("stripe-api-key")).toThrow(/dot identifier/i);
    expect(() => validateWorkflowSecretName("stripe..apiKey")).toThrow(/dot identifier/i);
  });
});

describe("workflow secret value handling", () => {
  it("encrypts with row-bound AAD and returns metadata only", async () => {
    selectRows.push(
      [secret()],
      [secret({ encryptedValue: "v2:ciphertext", encryptedValueIv: "iv" })],
    );
    encrypt.mockResolvedValue({ ciphertext: "v2:ciphertext", iv: "iv" });

    const result = await writeWorkflowSecretValue("org-1", "secret-1", "plaintext");

    expect(encrypt).toHaveBeenCalledWith("plaintext", "workflowSecret:secret-1:value");
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        encryptedValue: "v2:ciphertext",
        encryptedValueIv: "iv",
      }),
    );
    expect(result).toMatchObject({ id: "secret-1", hasValue: true });
    expect(result).not.toHaveProperty("value");
    expect(result).not.toHaveProperty("encryptedValue");
  });

  it("checks organization ownership before encrypting", async () => {
    selectRows.push([]);
    await expect(
      writeWorkflowSecretValue("other-org", "secret-1", "plaintext"),
    ).rejects.toMatchObject({ status: 404 });
    expect(encrypt).not.toHaveBeenCalled();
  });

  it("decrypts assigned values only on the internal runtime path", async () => {
    selectRows.push(
      [{ id: "workflow-1" }],
      [
        {
          secret: secret({
            encryptedValue: "v2:ciphertext",
            encryptedValueIv: "iv",
          }),
        },
      ],
    );
    decrypt.mockResolvedValue("plaintext");

    await expect(loadAssignedWorkflowSecretValues("org-1", "workflow-1")).resolves.toEqual({
      "stripe.apiKey": "plaintext",
    });
    expect(decrypt).toHaveBeenCalledWith("v2:ciphertext", "iv", "workflowSecret:secret-1:value");
  });
});
