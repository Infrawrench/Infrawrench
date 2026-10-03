import { describe, it, expect, vi } from "vitest";
import {
  listStoreSecrets,
  getStoreOptions,
  createStoreSecret,
  editStoreSecret,
  deleteStoreSecret,
  getSecretsQuota,
  parseScopes,
  NEW_STORE_OPTION,
} from "../clients/secrets-store-client.js";
import { CloudflareClient } from "../client.js";
import { plugin } from "../plugin.js";
import { makeApi, asyncIter } from "./_helpers.js";

const STORE = { id: "store1", name: "default_secrets_store", created: "c", modified: "m" };
const SECRET = {
  id: "sec1",
  name: "OPENAI_KEY",
  store_id: "store1",
  status: "active",
  scopes: ["workers", "ai_gateway"],
  comment: "prod key",
  created: "2026-01-01T00:00:00Z",
  modified: "2026-01-02T00:00:00Z",
};

function ssApi(stores: unknown[] = [STORE]) {
  const secretsStore = {
    stores: {
      list: vi.fn(() => asyncIter(stores)),
      create: vi.fn(async () => ({ id: "store-new", name: "default_secrets_store" })),
      secrets: {
        list: vi.fn(() => asyncIter([SECRET])),
        create: vi.fn(() => asyncIter([SECRET])),
        edit: vi.fn(async () => SECRET),
        delete: vi.fn(async () => null),
      },
    },
    quota: { get: vi.fn(async () => ({ secrets: { quota: 100, usage: 7 } })) },
  };
  return makeApi({ cf: { secretsStore } });
}

describe("secrets-store-client", () => {
  it("listStoreSecrets walks every store and maps scopes to toggles", async () => {
    const api = ssApi();
    const [s] = await listStoreSecrets(api, "acct");
    expect(s!.id).toBe("acct:secrets-store-secret:store1/sec1");
    expect(s!.externalId).toBe("store1/sec1");
    expect(s!.fields.storeName).toBe("default_secrets_store");
    expect(s!.fields.scopes).toBe("workers, ai_gateway");
    expect(s!.fields.scopeWorkers).toBe(true);
    expect(s!.fields.scopeAiGateway).toBe(true);
    expect(s!.fields.scopeAccess).toBe(false);
    expect(s!.fields.value).toBe("");
    expect(s!.resolvedOutputs).toEqual({ secretName: "OPENAI_KEY", storeId: "store1" });
  });

  it("listStoreSecrets surfaces a Secrets Store permission hint on a 403", async () => {
    const api = makeApi({
      cf: {
        secretsStore: {
          stores: {
            list: vi.fn(() => {
              throw { status: 403 };
            }),
          },
        },
      },
    });
    await expect(listStoreSecrets(api, "acct")).rejects.toThrow(/Secrets Store:Read/);
  });

  it("getStoreOptions offers to create a store when the account has none", async () => {
    expect(await getStoreOptions(ssApi())).toEqual([
      { id: "store1", label: "default_secrets_store" },
    ]);
    const [opt] = await getStoreOptions(ssApi([]));
    expect(opt!.id).toBe(NEW_STORE_OPTION);
  });

  it("parseScopes accepts the picker's JSON array or a comma list, dropping unknowns", () => {
    expect(parseScopes('["workers","nope","workers"]')).toEqual(["workers"]);
    expect(parseScopes("workers, ai_gateway")).toEqual(["workers", "ai_gateway"]);
    expect(parseScopes("")).toEqual([]);
  });

  it("createStoreSecret sends a one-item batch to the picked store", async () => {
    const api = ssApi();
    const out = await createStoreSecret(api, "acct", {
      storeId: "store1",
      name: "OPENAI_KEY",
      value: "sk-123",
      scopes: '["workers","ai_gateway"]',
      comment: "prod key",
    });
    expect(api.cf.secretsStore.stores.secrets.create).toHaveBeenCalledWith("store1", {
      account_id: "acct-cf",
      body: [
        {
          name: "OPENAI_KEY",
          value: "sk-123",
          scopes: ["workers", "ai_gateway"],
          comment: "prod key",
        },
      ],
    });
    expect(out.externalId).toBe("store1/sec1");
  });

  it("createStoreSecret creates the default store first when asked", async () => {
    const api = ssApi([]);
    await createStoreSecret(api, "acct", {
      storeId: NEW_STORE_OPTION,
      name: "K",
      value: "v",
      scopes: '["workers"]',
    });
    expect(api.cf.secretsStore.stores.create).toHaveBeenCalledWith({
      account_id: "acct-cf",
      name: "default_secrets_store",
    });
    expect(api.cf.secretsStore.stores.secrets.create).toHaveBeenCalledWith(
      "store-new",
      expect.anything(),
    );
  });

  it("createStoreSecret validates name, value and scopes", async () => {
    const api = ssApi();
    await expect(createStoreSecret(api, "acct", { name: "", value: "v" })).rejects.toThrow(/name/);
    await expect(createStoreSecret(api, "acct", { name: "K", value: "" })).rejects.toThrow(/value/);
    await expect(
      createStoreSecret(api, "acct", { name: "K", value: "v", scopes: "[]" }),
    ).rejects.toThrow(/at least one/);
  });

  it("editStoreSecret only rotates the value when the user typed one", async () => {
    const api = ssApi();
    const base = {
      scopeWorkers: "true",
      scopeAiGateway: "false",
      comment: "c",
      value: "",
      storeName: "s",
    };
    await editStoreSecret(api, "acct", "store1/sec1", base, ["comment"]);
    expect(api.cf.secretsStore.stores.secrets.edit).toHaveBeenLastCalledWith("store1", "sec1", {
      account_id: "acct-cf",
      scopes: ["workers"],
      comment: "c",
    });
    await editStoreSecret(api, "acct", "store1/sec1", { ...base, value: "new" }, ["value"]);
    expect(api.cf.secretsStore.stores.secrets.edit).toHaveBeenLastCalledWith(
      "store1",
      "sec1",
      expect.objectContaining({ value: "new" }),
    );
    await expect(
      editStoreSecret(api, "acct", "store1/sec1", { ...base, scopeWorkers: "false" }, []),
    ).rejects.toThrow(/at least one/);
  });

  it("deleteStoreSecret splits the composite id", async () => {
    const api = ssApi();
    await deleteStoreSecret(api, "store1/sec1");
    expect(api.cf.secretsStore.stores.secrets.delete).toHaveBeenCalledWith("store1", "sec1", {
      account_id: "acct-cf",
    });
    await expect(deleteStoreSecret(api, "bad")).rejects.toThrow(/malformed/);
  });

  it("getSecretsQuota reads quota and usage", async () => {
    expect(await getSecretsQuota(ssApi())).toEqual({ quota: 100, usage: 7 });
  });
});

describe("CloudflareClient secrets-store wiring", () => {
  function client() {
    const c = new CloudflareClient({ apiToken: "tok" }, plugin.resourceTypes);
    const api = ssApi();
    (c as unknown as { api: unknown }).api = api;
    return { c, api };
  }

  it("create config lists stores and documented scopes", async () => {
    const { c } = client();
    const cfg = await c.getCreateConfig("secrets-store-secret");
    const store = cfg.fields.find((f) => f.key === "storeId");
    expect(store?.options).toEqual([{ id: "store1", label: "default_secrets_store" }]);
    const scopes = cfg.fields.find((f) => f.key === "scopes");
    expect(scopes?.policies?.map((p) => p.id)).toContain("ai_gateway");
  });

  it("updateResource passes the changed keys through", async () => {
    const { c, api } = client();
    await c.updateResource(
      "secrets-store-secret",
      "acct:secrets-store-secret:store1/sec1",
      "acct",
      {
        comment: "rotated",
      },
    );
    const call = (api.cf.secretsStore.stores.secrets.edit as ReturnType<typeof vi.fn>).mock
      .calls[0] as unknown[];
    expect(call[2]).toEqual({
      account_id: "acct-cf",
      scopes: ["workers", "ai_gateway"],
      comment: "rotated",
    });
  });

  it("detail shows quota and a binding snippet; outputs resolve", async () => {
    const { c } = client();
    const [secret] = await c.listResources("secrets-store-secret", "acct");
    const schema = c.renderDetail(await c.enrichDetail(secret!));
    const json = JSON.stringify(schema);
    expect(json).toContain("7 of 100");
    expect(json).toContain("secrets_store_secrets");
    expect(
      await c.resolveOutput(
        "secrets-store-secret",
        "acct:secrets-store-secret:store1/sec1",
        "storeId",
        "acct",
      ),
    ).toBe("store1");
  });
});
