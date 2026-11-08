import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

/**
 * A plugin stores a one-time secret from inside `createResource`, and the secret's
 * table has a foreign key to a row this route writes afterwards (#588). The database
 * half of this is in server-core's `db/secret-writes.test.ts`; this is the order.
 */

const order: string[] = [];
const upsertCreatedResource = vi.fn(async () => {
  order.push("upsert");
});
const flush = vi.fn(async () => {
  order.push("flush");
});
vi.mock("@infrawrench/server-core/created-resource", () => ({ upsertCreatedResource }));
vi.mock("@infrawrench/server-core/secret-states", () => ({
  setLiteralSecretState: vi.fn(async () => {
    order.push("secretState");
  }),
  setOutputRefSecretState: vi.fn(),
  holdSecretWrites: () => ({
    run: async <T>(create: () => Promise<T>) => {
      order.push("run");
      return create();
    },
    flush,
  }),
}));

const dbMock = { db: {} };
vi.mock("../../../db/client", () => dbMock);
vi.mock("@infrawrench/server-core/db/client", () => dbMock);

const THING = {
  id: "acct-1:thing:t1",
  pluginId: "fake",
  resourceTypeId: "thing",
  accountId: "acct-1",
  displayName: "Thing",
  fields: {},
  resolvedOutputs: {},
  secretStates: [{ fieldKey: "stated", resolution: { kind: "plaintext", value: "s" } }],
};
const createResource = vi.fn(async () => {
  order.push("create");
  return THING;
});
const accountPlugin = { value: "fake" };
vi.mock("../../../services/plugin-clients", () => ({
  getClientForResource: vi.fn(async () => ({
    client: { createResource },
    account: { id: "acct-1", pluginId: accountPlugin.value },
  })),
  getClientForAccount: vi.fn(),
}));
vi.mock("../../../services/change-freezes", () => ({
  CHANGE_FREEZE_OVERRIDE_HEADER: "x-change-freeze-override",
  evaluateChangeFreeze: vi.fn(async () => null),
  getActiveChangeFreeze: vi.fn(async () => null),
  isActionDestructive: vi.fn(async () => false),
}));
vi.mock("../../../services/audit", () => ({ logAudit: vi.fn() }));
vi.mock("../../../services/tag-policy", () => ({
  evaluateTagPolicyOnCreate: vi.fn(async () => null),
}));

const { resourcesDomain } = await import("@/http/domains/resources/index");

function create() {
  return buildTestApi(resourcesDomain, { basePath: "/api/org/org-1/resources" }).request(
    "/create",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: "acct-1",
        pluginId: "fake",
        resourceTypeId: "thing",
        fields: {},
      }),
    },
  );
}

beforeEach(() => {
  order.length = 0;
  accountPlugin.value = "fake";
  vi.clearAllMocks();
});

describe("POST /create with a secret stored during the create", () => {
  it("writes it after the resource's row", async () => {
    const res = await create();
    expect(res.status).toBe(200);
    expect(order).toEqual(["run", "create", "upsert", "flush", "secretState"]);
  });

  it("still answers when the upsert fails, because the secret can still be stored", async () => {
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    upsertCreatedResource.mockRejectedValueOnce(new Error("down"));
    const res = await create();
    expect(res.status).toBe(200);
    expect(flush).toHaveBeenCalled();
  });

  it("says so when it could not be stored, without the failed query's text", async () => {
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    flush.mockRejectedValueOnce(new Error('Failed query: insert into "x" params: v2:ciphertext'));
    const res = await create();
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("was created but its credentials could not be stored");
    expect(body).not.toContain("ciphertext");
  });

  it("warns on a peer resource, which has no row of its own here", async () => {
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    accountPlugin.value = "another-plugin";
    flush.mockRejectedValueOnce(new Error("down"));
    const res = await create();
    expect(res.status).toBe(200);
    expect(upsertCreatedResource).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({
      warnings: [{ code: "secret-persist-failed" }],
    });
  });
});
